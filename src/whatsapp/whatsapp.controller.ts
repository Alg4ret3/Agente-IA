import { Controller, Headers, Post, Req, Body } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { WhatsAppService } from './whatsapp.service.js';

@Controller('openwa')
export class WhatsAppController {
  constructor(private readonly whatsapp: WhatsAppService) {}

  @Post('webhook')
  async webhook(
    @Req() request: RawBodyRequest<Request>,
    @Body() event: unknown,
    @Headers('x-openwa-signature') signature?: string,
  ) {
    if (!request.rawBody) {
      throw new Error('No fue posible leer el cuerpo original del webhook.');
    }

    return this.whatsapp.handleIncomingEvent(event, request.rawBody, signature);
  }
}
