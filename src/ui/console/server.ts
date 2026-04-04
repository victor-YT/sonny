import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';

import express, { type Express } from 'express';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface ConsoleServerConfig {
  host?: string;
  port?: number;
  publicDirectory?: string;
}

export interface ConsoleServerAddress {
  host: string;
  port: number;
  url: string;
}

export class ConsoleServer {
  private readonly host: string;
  private readonly port: number;
  private readonly publicDirectory: string;
  private readonly app: Express;
  private server: HttpServer | undefined;

  public constructor(config: ConsoleServerConfig = {}) {
    this.host = config.host ?? DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_PORT;
    this.publicDirectory =
      config.publicDirectory ?? join(__dirname, 'public');
    this.app = express();

    this.configure();
  }

  public async start(): Promise<ConsoleServerAddress> {
    if (this.server !== undefined) {
      return this.address;
    }

    await new Promise<void>((resolve, reject) => {
      const nextServer = this.app.listen(this.port, this.host, () => {
        this.server = nextServer;
        resolve();
      });

      nextServer.once('error', reject);
    });

    return this.address;
  }

  public async stop(): Promise<void> {
    if (this.server === undefined) {
      return;
    }

    const activeServer = this.server;
    this.server = undefined;

    await new Promise<void>((resolve, reject) => {
      activeServer.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  public get expressApp(): Express {
    return this.app;
  }

  public get address(): ConsoleServerAddress {
    return {
      host: this.host,
      port: this.port,
      url: `http://${this.host}:${this.port}`,
    };
  }

  private configure(): void {
    this.app.disable('x-powered-by');
    this.app.use(express.json());

    if (existsSync(this.publicDirectory)) {
      this.app.use(express.static(this.publicDirectory));
    }

    this.app.get('/', (_request, response) => {
      response.type('text/plain').send('Sonny console server is running.');
    });
  }
}

export async function startConsoleServer(
  config: ConsoleServerConfig = {},
): Promise<ConsoleServer> {
  const server = new ConsoleServer(config);
  await server.start();
  return server;
}
