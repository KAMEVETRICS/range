declare module "ioredis-mock" {
  import type { RedisCommands } from "./current-state.js";
  export default class Redis implements RedisCommands {
    eval(script: string, numberOfKeys: number, ...args: (string | number)[]): Promise<unknown>;
    get(key: string): Promise<string | null>;
    zrangebyscore(key: string, min: string | number, max: string | number, ...args: (string | number)[]): Promise<string[]>;
    disconnect(): void;
  }
}
