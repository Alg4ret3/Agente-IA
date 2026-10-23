import {
  Controller,
  Get,
  Query,
  BadRequestException,
  Body,
  Post,
} from '@nestjs/common';
import { AiService } from './ai/ai.service.js';
import { DatabaseService } from './database/database.service.js';

@Controller()
export class AppController {
  constructor(
    private readonly database: DatabaseService,
    private readonly ai: AiService,
  ) {}

  @Get('productos')
  async productos(@Query('buscar') buscar = '') {
    return this.database.consultarProductos(buscar);
  }

  @Get('cotizar')
  async cotizar(@Query('id') id: string, @Query('cantidad') cantidad: string) {
    const idProducto = Number(id);
    const unidades = Number(cantidad);

    if (
      !id ||
      !cantidad ||
      !Number.isInteger(idProducto) ||
      !Number.isInteger(unidades) ||
      idProducto < 1 ||
      unidades < 1
    ) {
      throw new BadRequestException(
        'Debes proporcionar un ID y una cantidad enteros positivos.',
      );
    }

    return this.database.cotizarProducto(idProducto, unidades);
  }

  @Post('chat')
  async chat(@Body() body: { mensaje?: string }) {
    const mensaje = body.mensaje?.trim();

    if (!mensaje || mensaje.length > 2000) {
      throw new BadRequestException(
        'El mensaje es obligatorio y no puede superar 2000 caracteres.',
      );
    }

    return this.ai.responder(mensaje);
  }
}
