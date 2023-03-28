import {
  Authenticator,
  Codec,
  JetStreamClient,
  JetStreamManager,
  NatsConnection,
  ObjectStore,
} from "nats";
import { RestBindParameters } from "sqlite3";

export type NatsInit = {
  url: string;
  app: string;
  creds: string;
  token: string;
};

export type NatsConf = {
  servers: string;
  authenticator?: Authenticator;
  token?: string;
  maxReconnectAttempts?: number;
};

export type NatsRes = {
  nc: NatsConnection;
  sc: Codec<string>;
  js: JetStreamClient;
  os: ObjectStore;
  jsm: JetStreamManager;
};

export type ParseRes = {
  error: string;
  simple: boolean;
  query: string;
  params: RestBindParameters;
  t: number;
  data: JSON;
  isRead: boolean;
  bulkItems: string[];
  bulkParams: bulkParams[];
};

type bulkParams = {
  query: string;
  params: RestBindParameters;
};

export type Res = {
  error?: string;
  results: Array<Record<string, unknown>>;
  time: number;
};

export type Options = {
  url: string;
  creds: string;
  token: string;
  dataDir: string;
  externalBackup: string;
  externalBackupUrl: string;
};
