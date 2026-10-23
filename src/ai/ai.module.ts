import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { AiService } from './ai.service.js';

@Module({
  imports: [DatabaseModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
