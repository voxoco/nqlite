import {
  Authenticator,
  Codec,
  ConsumerOptsBuilder,
  JetStreamClient,
  JetStreamManager,
  KV,
  ObjectStore,
} from "natsws";
import { RestBindParameters } from "sqlite3";

export type NatsInit = {
  url: string;
  app: string;
  dataDir: string;
  creds: string;
  token: string;
};

export type NatsConf = {
  servers: string;
  authenticator?: Authenticator;
  token?: string;
};

export type NatsRes = {
  sc: Codec<string>;
  js: JetStreamClient;
  os: ObjectStore;
  kv: KV;
  opts: ConsumerOptsBuilder;
  jsm: JetStreamManager;
  lastSeq: number;
};

export type ParseRes = {
  error: string;
  simple: boolean;
  query: string;
  params: RestBindParameters;
  t: number;
  data: JSON;
  isRead: boolean;
  txItems: string[];
};

export type Res = {
  error?: string;
  results: Array<Record<string, unknown>>;
  time: number;
};
