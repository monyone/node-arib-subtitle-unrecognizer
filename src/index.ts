import fs from 'fs';
import { Transform, TransformCallback } from 'stream'

import { TSPacket, TSPacketChunker } from 'arib-mpeg2ts-parser';
import { TSSection, TSSectionQueue } from 'arib-mpeg2ts-parser';

import { Command } from 'commander';
const program = new Command();

program
  .option('-i', '--input <path>', 'input mpeg2ts path')
  .option('-o', '--output <path>', 'output mpeg2ts path')
const options = program.opts();

const src = options.input == null || options.input === '-' ? process.stdin : fs.createReadStream(options.input);
const dst = options.output == null || options.output === '-' ? process.stdout : fs.createWriteStream(options.output);
const ts_packet_chunker = new TSPacketChunker();

const PAT_TSSectionQueue = new TSSectionQueue();
const PMT_TSSectionQueues = new Map<number, TSSectionQueue>();
const PMT_ContinuityCounters = new Map<number, number>();

const subtitle_unrecognize_transfomer = new Transform({
  transform(packet: Buffer, encoding: string, callback: TransformCallback): void {
    const pid = TSPacket.pid(packet);

    if (pid == 0x00) {
      PAT_TSSectionQueue.push(packet)
      while (!PAT_TSSectionQueue.isEmpty()) { 
        const PAT = PAT_TSSectionQueue.pop()!;
        if (TSSection.CRC32(PAT) != 0) { continue; }

        let begin = TSSection.EXTENDED_HEADER_SIZE;
        while (begin < TSSection.BASIC_HEADER_SIZE + TSSection.section_length(PAT) - TSSection.CRC_SIZE) {
          const program_number = (PAT[begin + 0] << 8) | PAT[begin + 1];
          const program_map_PID = ((PAT[begin + 2] & 0x1F) << 8) | PAT[begin + 3];
          if (program_map_PID === 0x10) { begin += 4; continue; } // NIT
          
          if (!PMT_TSSectionQueues.has(program_map_PID)) {
            PMT_TSSectionQueues.set(program_map_PID, new TSSectionQueue());
            PMT_ContinuityCounters.set(program_map_PID, 0);
          }

          begin += 4;
        }
      }
      this.push(packet);
    } else if (PMT_TSSectionQueues.has(pid)) {
      const PMT_TSSectionQueue = PMT_TSSectionQueues.get(pid)!;

      PMT_TSSectionQueue.push(packet);
      while (!PMT_TSSectionQueue.isEmpty()) {
        const PMT = PMT_TSSectionQueue.pop()!;
        if (TSSection.CRC32(PMT) != 0) { continue; }
        
        const program_info_length = ((PMT[TSSection.EXTENDED_HEADER_SIZE + 2] & 0x0F) << 8) | PMT[TSSection.EXTENDED_HEADER_SIZE + 3];
        let newPMT = PMT.slice(0, TSSection.EXTENDED_HEADER_SIZE + 4 + program_info_length);

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

        begin = 0;
        while (begin < newPMT.length) {
          const continuity_counter = PMT_ContinuityCounters.get(pid)!;
          const header = Buffer.from([
            packet[0],
            (packet[1] & 0xBF) | ((begin === 0 ? 1 : 0) << 6),
            packet[2],
            (packet[3] & 0xD0) | (continuity_counter & 0x0F),
          ]);
          PMT_ContinuityCounters.set(pid, (continuity_counter + 1) & 0x0F);
          
          const next = Math.min(newPMT.length, begin + ((TSPacket.PACKET_SIZE - TSPacket.HEADER_SIZE) - (begin === 0 ? 1 : 0)));
          let payload = newPMT.slice(begin, next);
          if (begin === 0) { payload = Buffer.concat([Buffer.alloc(1), payload]); }
          const fillStuffingSize = Math.max(0, TSPacket.PACKET_SIZE - (TSPacket.HEADER_SIZE + payload.length))
          payload = Buffer.concat([payload, Buffer.alloc(fillStuffingSize, TSPacket.STUFFING_BYTE)]);

          const new_packet = Buffer.concat([header, payload]);
          this.push(new_packet);

          begin = next;
        }
      }
    } else {
      this.push(packet);
    }
    callback();
  }
});

src
  .pipe(ts_packet_chunker)
  .pipe(subtitle_unrecognize_transfomer)
  .pipe(dst);