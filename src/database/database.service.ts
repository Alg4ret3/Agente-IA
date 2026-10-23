import {
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly pool: Pool;

  constructor(private readonly config: ConfigService) {
    this.pool = new Pool({
      host: this.config.get<string>('DB_HOST', 'localhost'),
      port: Number(this.config.get<string>('DB_PORT', '5432')),
      database: this.config.get<string>('DB_NAME', 'systemdistrimagik'),
      user: this.config.get<string>('DB_USER', 'agente_ia_lectura'),
      password: this.config.get<string>('DB_PASSWORD'),
      application_name: 'distri-magik-agent',
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
  }

  async onModuleInit() {
    try {
      await this.pool.query('SET default_transaction_read_only = on');
      await this.pool.query('SELECT 1');
      console.log('Conexión PostgreSQL de solo lectura establecida.');
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo conectar con PostgreSQL. Revisa la configuración local.',
      );
    }
  }

  async onModuleDestroy() {
    await this.pool.end();
  }

  async consultarProductos(busqueda = '') {
    const consulta = `
      SELECT
        p."ID_Producto" AS id,
        p."Nombre" AS nombre,
        m."Nombre" AS marca,
        c."Nombre" AS categoria,
        l."ID_Lote" AS id_lote,
        l."Stock_actual" AS stock,
        l."Precio_venta_1" AS precio_1,
        l."Precio_venta_2" AS precio_2,
        l."Precio_venta_3" AS precio_3,
        l."Precio_venta_4" AS precio_4
      FROM public."PRODUCTOS" p
      JOIN public."LOTES_PRODUCTO" l
        ON l."ID_Producto" = p."ID_Producto"
      LEFT JOIN public."MARCAS" m
        ON m."ID_Marca" = p."ID_Marca"
      LEFT JOIN public."CATEGORIAS" c
        ON c."ID_Categoria" = p."ID_Categoria"
      WHERE p."Estado" = TRUE
        AND l."Estado" = TRUE
        AND l."Stock_actual" > 0
        AND p."Nombre" ILIKE $1
      ORDER BY p."Nombre", l."ID_Lote"
      LIMIT 30
    `;

    try {
      const resultado = await this.pool.query(consulta, [
        `%${busqueda.trim()}%`,
      ]);

      return resultado.rows;
    } catch {
      throw new ServiceUnavailableException(
        'No se pudo consultar el catálogo de productos.',
      );
    }
  }

  seleccionarPrecio(cantidad: number) {
    if (!Number.isInteger(cantidad) || cantidad < 1) {
      throw new Error('La cantidad debe ser un entero positivo.');
    }

    if (cantidad >= 24) {
      return { nivel: 4, campo: 'precio_4' };
    }

    if (cantidad >= 12) {
      return { nivel: 3, campo: 'precio_3' };
    }

    if (cantidad >= 6) {
      return { nivel: 2, campo: 'precio_2' };
    }

    return { nivel: 1, campo: 'precio_1' };
  }

  async cotizarProducto(idProducto: number, cantidad: number) {
    if (!Number.isInteger(idProducto) || idProducto < 1) {
      throw new Error('El ID del producto no es válido.');
    }

    if (!Number.isInteger(cantidad) || cantidad < 1) {
      throw new Error('La cantidad debe ser un entero positivo.');
    }

    const resultado = await this.pool.query(
      `
      SELECT
        p."ID_Producto" AS id,
        p."Nombre" AS nombre,
        m."Nombre" AS marca,
        c."Nombre" AS categoria,
        l."ID_Lote" AS id_lote,
        l."Stock_actual" AS stock,
        l."Precio_venta_1" AS precio_1,
        l."Precio_venta_2" AS precio_2,
        l."Precio_venta_3" AS precio_3,
        l."Precio_venta_4" AS precio_4
      FROM public."PRODUCTOS" p
      JOIN public."LOTES_PRODUCTO" l
        ON l."ID_Producto" = p."ID_Producto"
      LEFT JOIN public."MARCAS" m
        ON m."ID_Marca" = p."ID_Marca"
      LEFT JOIN public."CATEGORIAS" c
        ON c."ID_Categoria" = p."ID_Categoria"
      WHERE p."ID_Producto" = $1
        AND p."Estado" = TRUE
        AND l."Estado" = TRUE
        AND l."Stock_actual" > 0
      ORDER BY l."ID_Lote"
      `,
      [idProducto],
    );

    if (resultado.rows.length === 0) {
      return {
        disponible: false,
        mensaje: 'No se encontraron lotes activos con existencias.',
      };
    }

    const lotes = resultado.rows;
    const stockTotal = lotes.reduce(
      (total, lote) => total + Number(lote.stock),
      0,
    );

    if (cantidad > stockTotal) {
      return {
        disponible: false,
        nombre: lotes[0].nombre,
        cantidadSolicitada: cantidad,
        stockDisponible: stockTotal,
        mensaje: 'La cantidad solicitada supera las existencias disponibles.',
      };
    }

    const { nivel, campo } = this.seleccionarPrecio(cantidad);

    // Cotizamos el lote de menor ID que tenga existencias.
    // Más adelante podemos adaptar esto a la política real de despacho.
    let restante = cantidad;
    let subtotal = 0;

    const detalle = [];

    for (const lote of lotes) {
      if (restante <= 0) break;

      const unidades = Math.min(restante, Number(lote.stock));
      const precio = Number(lote[campo]);

      subtotal += unidades * precio;
      detalle.push({
        idLote: lote.id_lote,
        unidades,
        precioUnitario: precio,
        subtotal: unidades * precio,
      });

      restante -= unidades;
    }

    return {
      disponible: true,
      producto: {
        id: lotes[0].id,
        nombre: lotes[0].nombre,
        marca: lotes[0].marca,
        categoria: lotes[0].categoria,
      },
      cantidad,
      nivelPrecio: nivel,
      subtotal,
      detalle,
      requiereAprobacionAsesor: true,
    };
  }
}
