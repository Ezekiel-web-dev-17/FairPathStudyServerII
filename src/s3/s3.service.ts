import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service.js';

export interface IS3UploadResult {
  url: string;
  s3Key: string;
  storedLocally: boolean;
}

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private s3Client: S3Client | null = null;
  private readonly bucketName: string;
  private readonly region: string;
  private readonly fallbackDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.region = this.configService.get<string>('AWS_REGION', 'us-east-1');
    this.bucketName = this.configService.get<string>('AWS_S3_BUCKET_NAME', 'fairpath-documents');

    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY');

    this.fallbackDir = path.resolve(process.cwd(), 'uploads', 'documents', 'fallback');
    if (!fs.existsSync(this.fallbackDir)) {
      fs.mkdirSync(this.fallbackDir, { recursive: true });
    }

    if (accessKeyId && secretAccessKey) {
      this.s3Client = new S3Client({
        region: this.region,
        credentials: {
          accessKeyId,
          secretAccessKey,
        },
      });
      this.logger.log(`S3 client initialized for bucket '${this.bucketName}' in region '${this.region}'.`);
    } else {
      this.logger.warn('AWS S3 credentials missing (AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY). S3Service will operate in local fallback mode.');
    }
  }

  async uploadFile(fileBuffer: Buffer, s3Key: string, mimeType: string): Promise<IS3UploadResult> {
    const cleanKey = this.extractS3Key(s3Key);

    if (this.s3Client) {
      try {
        this.logger.log(`Uploading file to S3 bucket '${this.bucketName}' key '${cleanKey}'...`);
        const command = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: cleanKey,
          Body: fileBuffer,
          ContentType: mimeType,
        });

        await this.s3Client.send(command);

        const s3Url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${cleanKey}`;
        this.logger.log(`File successfully uploaded to S3: ${s3Url}`);
        return {
          url: s3Url,
          s3Key: cleanKey,
          storedLocally: false,
        };
      } catch (error: any) {
        this.logger.error(`S3 upload failed for key '${cleanKey}': ${error.message}. Saving to local fallback storage.`, error.stack);
      }
    }

    // Fallback: Save file locally if S3 is unconfigured, unreachable, or throws error
    return this.saveToLocalFallback(fileBuffer, cleanKey);
  }

  async getFileBuffer(s3KeyOrUrl: string, localFallbackPath?: string): Promise<Buffer> {
    const cleanKey = this.extractS3Key(s3KeyOrUrl);

    // 1. Try S3 if configured
    if (this.s3Client && cleanKey && !cleanKey.startsWith('/')) {
      try {
        this.logger.log(`Fetching file buffer from S3 bucket '${this.bucketName}' key '${cleanKey}'...`);
        const command = new GetObjectCommand({
          Bucket: this.bucketName,
          Key: cleanKey,
        });

        const response = await this.s3Client.send(command);
        if (response.Body) {
          return await this.streamToBuffer(response.Body as Readable);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to fetch key '${cleanKey}' from S3: ${error.message}. Attempting local fallback.`);
      }
    }

    // 2. Local Fallback read
    const fallbackPath = localFallbackPath || path.join(this.fallbackDir, path.basename(cleanKey));
    if (fs.existsSync(fallbackPath)) {
      this.logger.log(`Reading document buffer from local fallback path: ${fallbackPath}`);
      return await fs.promises.readFile(fallbackPath);
    }

    throw new Error(`Document file at key '${cleanKey}' / path '${fallbackPath}' could not be retrieved from S3 or local storage.`);
  }

  async syncPendingLocalFiles(): Promise<{ syncedCount: number; errors: number }> {
    if (!this.s3Client) {
      return { syncedCount: 0, errors: 0 };
    }

    let syncedCount = 0;
    let errors = 0;

    try {
      if (!fs.existsSync(this.fallbackDir)) return { syncedCount, errors };

      const files = await fs.promises.readdir(this.fallbackDir);
      for (const fileName of files) {
        const filePath = path.join(this.fallbackDir, fileName);
        const stat = await fs.promises.stat(filePath);
        if (!stat.isFile()) continue;

        try {
          // Find document record in database associated with this local fallback path
          const matchingDoc = await this.prisma.document.findFirst({
            where: {
              fileUrl: {
                contains: fileName,
              },
            },
          });

          const s3Key = matchingDoc ? `documents/${matchingDoc.studentId}/${fileName}` : `documents/synced/${fileName}`;
          const fileBuffer = await fs.promises.readFile(filePath);
          const mimeType = matchingDoc?.mimeType || 'application/octet-stream';

          const command = new PutObjectCommand({
            Bucket: this.bucketName,
            Key: s3Key,
            Body: fileBuffer,
            ContentType: mimeType,
          });

          await this.s3Client.send(command);
          const s3Url = `https://${this.bucketName}.s3.${this.region}.amazonaws.com/${s3Key}`;

          if (matchingDoc) {
            await this.prisma.document.update({
              where: { id: matchingDoc.id },
              data: { fileUrl: s3Url },
            });
          }

          await fs.promises.unlink(filePath);
          this.logger.log(`Successfully synced local fallback file '${fileName}' to S3 (${s3Url}). Deleted local fallback copy.`);
          syncedCount++;
        } catch (err: any) {
          this.logger.error(`Failed to sync local fallback file '${fileName}' to S3: ${err.message}`);
          errors++;
        }
      }
    } catch (e: any) {
      this.logger.error(`Error executing syncPendingLocalFiles: ${e.message}`);
    }

    return { syncedCount, errors };
  }

  private extractS3Key(keyOrUrl: string): string {
    if (!keyOrUrl) return keyOrUrl;
    if (keyOrUrl.startsWith('http://') || keyOrUrl.startsWith('https://')) {
      try {
        const url = new URL(keyOrUrl);
        return url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
      } catch {
        const match = keyOrUrl.match(/s3[.-][a-z0-9-]+\.amazonaws\.com\/(.+)/i);
        return match ? match[1] : keyOrUrl;
      }
    }
    return keyOrUrl;
  }

  private async saveToLocalFallback(fileBuffer: Buffer, s3Key: string): Promise<IS3UploadResult> {
    const fileName = path.basename(s3Key);
    const targetPath = path.join(this.fallbackDir, fileName);

    await fs.promises.writeFile(targetPath, fileBuffer);
    this.logger.log(`Saved document to local fallback storage at: ${targetPath}`);

    return {
      url: targetPath,
      s3Key,
      storedLocally: true,
    };
  }

  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      stream.on('error', (err) => reject(err));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
}
