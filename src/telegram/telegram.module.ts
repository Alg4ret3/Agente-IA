import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { TelegramService } from './telegram.service.js';

@Module({
  imports: [AiModule, DatabaseModule],
  providers: [TelegramService],
})
export class TelegramModule {}
