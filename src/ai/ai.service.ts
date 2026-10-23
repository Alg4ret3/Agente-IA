import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';

export type ConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

@Injectable()
export class AiService {
  constructor(private readonly database: DatabaseService) {}

  async responder(mensaje: string, historial: ConversationMessage[] = []) {
    const palabras =
      mensaje
        .toLocaleLowerCase('es')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .match(/[a-z0-9]+/g) ?? [];

    const ignorar = new Set([
      'hola',
      'buenas',
      'buenos',
      'dias',
      'tardes',
      'noches',
      'que',
      'como',
      'cuando',
      'donde',
      'cual',
      'cuanto',
      'cuesta',
      'precio',
      'precios',
      'por',
      'favor',
      'quiero',
      'necesito',
      'tienen',
      'tienes',
      'hay',
      'para',
      'con',
      'una',
      'uno',
      'unos',
      'unas',
      'del',
      'las',
      'los',
      'una',
      'este',
      'esta',
      'ese',
      'esa',
      'me',
      'puedes',
      'venden',
      'vender',
      'producto',
      'productos',
    ]);

    const terminos = [
      ...new Set(
        palabras.filter(
          (palabra) => palabra.length >= 3 && !ignorar.has(palabra),
        ),
      ),
    ].slice(0, 4);

    const productos = new Map<number, Record<string, unknown>>();

    for (const termino of terminos) {
      const encontrados = await this.database.consultarProductos(termino);

      for (const producto of encontrados) {
        productos.set(Number(producto.id), producto);

        if (productos.size >= 12) break;
      }

      if (productos.size >= 12) break;
    }

    let catalogo = [...productos.values()];

    // Si la búsqueda no encuentra coincidencias, consultar
    // el catálogo general para no asumir que está vacío.
    if (catalogo.length === 0) {
      catalogo = await this.database.consultarProductos('');
    }

    const instrucciones = `
Eres el asistente comercial de Distri Magik,
una distribuidora de productos para uñas y belleza en Colombia.

REGLAS:
- Responde siempre en español, de forma amable, breve y profesional.
- No muestres razonamientos internos ni procesos de pensamiento.
- Recomienda productos únicamente cuando los datos disponibles lo permitan.
- Usa exclusivamente el catálogo proporcionado para afirmar existencias,
  marcas, categorías y precios.
- Si no encuentras un producto, dilo con honestidad y pide más detalles.
- No inventes productos, marcas, precios ni cantidades disponibles.
- Los precios corresponden a estas cantidades del mismo producto:
  precio_1: de 1 a 5 unidades.
  precio_2: de 6 a 11 unidades.
  precio_3: de 12 a 23 unidades.
  precio_4: 24 unidades o más.
- No sumes cantidades de productos diferentes para elegir el precio.
- No afirmes que un pedido está confirmado ni que el inventario está reservado.
- Los pedidos requieren aprobación de un asesor.
- Si no hay productos relevantes en el catálogo, responde a la consulta
  general sin inventar información comercial.

CATÁLOGO ENCONTRADO:
${JSON.stringify(catalogo)}
`;

    try {
      const respuesta = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen3.5:4b',
          think: false,
          stream: false,
          messages: [
            { role: 'system', content: instrucciones },
            ...historial,
            { role: 'user', content: mensaje },
          ],
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (!respuesta.ok) {
        throw new Error('Ollama devolvió un error HTTP.');
      }

      const datos = (await respuesta.json()) as {
        message?: { content?: string };
      };

      const contenido = datos.message?.content?.trim();

      if (!contenido) {
        throw new Error('Ollama devolvió una respuesta vacía.');
      }

      return {
        respuesta: contenido,
        productosConsultados: catalogo.length,
      };
    } catch {
      throw new ServiceUnavailableException(
        'El asistente no está disponible en este momento. Inténtalo de nuevo.',
      );
    }
  }
}
