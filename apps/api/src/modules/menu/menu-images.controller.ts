import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AppConfigService } from '../../config/app-config.service';
import type { AuthContext } from '../auth/auth.types';
import { CurrentAuth, Public, RequirePermission } from '../auth/decorators';

const MAX_BYTES = 2 * 1024 * 1024;

/** Accepted types, recognised by their first bytes (the browser-sent type is not trusted). */
const TYPES: { ext: string; mime: string; magic: (b: Buffer) => boolean }[] = [
  { ext: 'jpg', mime: 'image/jpeg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: 'png',
    mime: 'image/png',
    magic: (b) =>
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    magic: (b) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^([0-9a-f-]{36})\.(jpg|png|webp)$/;

/**
 * Menu photos. Uploads are stored on local disk under UPLOADS_DIR/menu/<tenant>/ and served
 * publicly (they appear on the POS and customer QR menu). File names are random UUIDs, so they
 * cannot be guessed or listed.
 */
@ApiTags('Menu')
@Controller()
export class MenuImagesController {
  private readonly root: string;

  constructor(config: AppConfigService) {
    this.root = resolve(config.get('UPLOADS_DIR'), 'menu');
  }

  @Post('menu/images')
  @RequirePermission('menu:manage')
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload a menu item photo (JPG, PNG or WebP, up to 2 MB)' })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_BYTES, files: 1 } }))
  async upload(
    @CurrentAuth() auth: AuthContext,
    @UploadedFile() file: { buffer: Buffer; size: number } | undefined,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException({ code: 'IMAGE_REQUIRED', message: 'Choose an image.' });
    }
    const type = TYPES.find((t) => t.magic(file.buffer));
    if (!type) {
      throw new BadRequestException({
        code: 'IMAGE_TYPE',
        message: 'Use a JPG, PNG or WebP image.',
      });
    }
    const tenant = auth.tenantId!;
    const name = `${randomUUID()}.${type.ext}`;
    const dir = resolve(this.root, tenant);
    await mkdir(dir, { recursive: true });
    await writeFile(resolve(dir, name), file.buffer, { flag: 'wx' });
    return { url: `/media/menu/${tenant}/${name}` };
  }

  @Get('media/menu/:tenant/:file')
  @Public()
  @ApiOperation({ summary: 'A menu photo (public)' })
  async serve(
    @Param('tenant') tenant: string,
    @Param('file') file: string,
    // Not passthrough: the file is written straight to the response, so the global JSON
    // envelope never wraps (and leaks the disk path of) the stream.
    @Res() res: Response,
  ) {
    const m = FILE.exec(file);
    if (!UUID.test(tenant) || !m) throw new NotFoundException();
    const path = resolve(this.root, tenant, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new NotFoundException();
    res.set({
      'Content-Type': TYPES.find((t) => t.ext === m[2])!.mime,
      // Names are never reused, so the file can be cached for good.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.setHeader('Content-Length', info.size);
    createReadStream(path)
      .on('error', () => res.destroy())
      .pipe(res);
  }
}
