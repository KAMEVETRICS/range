declare module "ioredis-mock" {
  import type { RedisCommands } from "./current-state.js";
  export default class Redis implements RedisCommands {
    eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
    get(key: string): Promise<string | null>;
    mget(...keys: string[]): Promise<(string | null)[]>;
    set(key: string, value: string, mode: "PX", milliseconds: number): Promise<unknown>;
    zrange(key: string, start: number, stop: number): Promise<string[]>;
    zrangebyscore(key: string, min: string | number, max: string | number, ...args: (string | number)[]): Promise<string[]>;
    disconnect(): void;
  }
}
