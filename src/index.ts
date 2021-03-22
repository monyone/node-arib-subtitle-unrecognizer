#!/usr/bin/env node

import { Transform, TransformCallback } from 'stream'

import { TSPacket, TSPacketQueue } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue, TSSectionPacketizer } from 'arib-mpeg2ts-parser';
import { TSPES } from 'arib-mpeg2ts-parser';

export default class UnrecognizeTransform extends Transform {
  private packetQueue = new TSPacketQueue();
  private PAT_TSSectionQueue = new TSSectionQueue();
  private PMT_TSSectionQueues = new Map<number, TSSectionQueue>();
  private PMT_ContinuityCounters = new Map<number, number>();
  private PMT_SubtitlePids = new Map<number, number>();
  private Subtitle_Pids = new Set<number>();

  _transform (chunk: Buffer, encoding: string, callback: TransformCallback): void {
    this.packetQueue.push(chunk);
    while (!this.packetQueue.isEmpty()) {
      const packet = this.packetQueue.pop()!;

      const pid = TSPacket.pid(packet);

      if (pid == 0x00) {
        this.PAT_TSSectionQueue.push(packet)
        while (!this.PAT_TSSectionQueue.isEmpty()) { 
          const PAT = this.PAT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PAT) != 0) { continue; }

          let begin = TSSection.EXTENDED_HEADER_SIZE;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PAT) - TSSection.CRC_SIZE) {
            const program_number = (PAT[begin + 0] << 8) | PAT[begin + 1];
            const program_map_PID = ((PAT[begin + 2] & 0x1F) << 8) | PAT[begin + 3];
            if (program_map_PID === 0x10) { begin += 4; continue; } // NIT

            if (!this.PMT_TSSectionQueues.has(program_map_PID)) {
              this.PMT_TSSectionQueues.set(program_map_PID, new TSSectionQueue());
              this.PMT_ContinuityCounters.set(program_map_PID, 0);
            }

            begin += 4;
          }
        }
      
        this.push(packet);
      } else if (this.PMT_TSSectionQueues.has(pid)) {
        const PMT_TSSectionQueue = this.PMT_TSSectionQueues.get(pid)!;
        if (this.PMT_SubtitlePids.has(pid)) { this.Subtitle_Pids.delete(this.PMT_SubtitlePids.get(pid)!); }
        this.PMT_SubtitlePids.delete(pid);

        PMT_TSSectionQueue.push(packet);
        while (!PMT_TSSectionQueue.isEmpty()) {
          const PMT = PMT_TSSectionQueue.pop()!;
          if (TSSection.CRC32(PMT) != 0) { continue; }

          const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
          let newPMT = Buffer.from(PMT.slice(0, TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length));

          let begin = TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length;
          while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PMT) - TSSection.CRC_SIZE) {
            const stream_type = PMT[begin + 0];
            const elementary_PID = ((PMT[begin + 1] & 0x1F) << 8) | PMT[begin + 2];
            const ES_info_length = ((PMT[begin + 3] & 0x0F) << 8) | PMT[begin + 4];

            let isSubtitle = false;

            let descriptor = begin + 5;
            while (descriptor < begin + 5 + ES_info_length) {
              const descriptor_tag = PMT[descriptor + 0];
              const descriptor_length = PMT[descriptor + 1];

              if (descriptor_tag == 0x52) {
                const component_tag = PMT[descriptor + 2];

                if (0x30 <= component_tag && component_tag <= 0x37 || component_tag == 0x87) {
                  isSubtitle = true;
                }
              }

              descriptor += 2 + descriptor_length;
            }

            if (isSubtitle) {
              this.PMT_SubtitlePids.set(pid, elementary_PID);
              this.Subtitle_Pids.add(elementary_PID);
              newPMT = Buffer.concat([newPMT, PMT.slice(begin, begin + 3), Buffer.alloc(2)]);
            } else {
              newPMT = Buffer.concat([newPMT, PMT.slice(begin, begin + 5 + ES_info_length)]);
            }

            begin += 5 + ES_info_length;
          }
        
          const newPMT_length = newPMT.length + TSSection.CRC_SIZE - TSSection.BASIC_HEADER_SIZE;
          newPMT[1] = (PMT[1] & 0xF0) | ((newPMT_length & 0x0F00) >> 8);
          newPMT[2] = (newPMT_length & 0x00FF);

          const newPMT_CRC = TSSection.CRC32(newPMT);
          newPMT = Buffer.concat([newPMT, Buffer.from([
            (newPMT_CRC & 0xFF000000) >> 24,
            (newPMT_CRC & 0x00FF0000) >> 16,
            (newPMT_CRC & 0x0000FF00) >> 8,
            (newPMT_CRC & 0x000000FF) >> 0,
          ])]);

          const packets = TSSectionPacketizer.packetize(
            newPMT,
            TSPacket.transport_error_indicator(packet),
            TSPacket.transport_priority(packet),
            pid,
            TSPacket.transport_scrambling_control(packet),
            this.PMT_ContinuityCounters.get(pid)!
          );
          for (let i = 0; i < packets.length; i++) { this.push(packets[i]); }
          this.PMT_ContinuityCounters.set(pid, (this.PMT_ContinuityCounters.get(pid)! + packets.length) & 0x0F);
        }
      } else if (this.Subtitle_Pids.has(pid)) {
        if (TSPacket.payload_unit_start_indicator(packet)) {
          const pes_start_index = TSPacket.HEADER_SIZE + (TSPacket.has_adaptation_field(packet) ? 1 + TSPacket.adaptation_field_length(packet): 0);
          const pes_buffer = packet.slice(pes_start_index);
          if (TSPES.packet_start_code_prefix(pes_buffer) === 1) {
            pes_buffer[3] = 0xFC;
          }
          this.push(packet);
        } else {
          this.push(packet);
        }
      } else {
        this.push(packet);
      }
    }
    callback();
  }

  _flush (callback: TransformCallback): void {
    callback();
  }
}
