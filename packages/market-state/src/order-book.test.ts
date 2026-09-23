import { describe, expect, it } from "vitest";
import { OrderBook } from "./order-book.js";
import { observation } from "./test-fixtures.js";

describe("OrderBook", () => {
  it("sorts levels by exact decimal price and removes a zero quantity delta", () => {
    const book = new OrderBook();
    book.applySnapshot(observation("100", [["9.9", "1"], ["10", "2"]], [["11", "3"], ["10.1", "4"]]));
    book.applyDelta(observation("101", [["10", "0"], ["9.95", "2"]], [["10.1", "0"]]));
    expect(book.status()).toBe("valid");
    expect(book.levels("buy")).toEqual([{ price: "11", quantity: "3" }]);
    expect(book.levels("sell")).toEqual([
      { price: "9.95", quantity: "2" },
      { price: "9.9", quantity: "1" },
    ]);
  });

  it.each([
    ["gap", ["101", "103"]],
    ["out of order", ["102", "101"]],
    ["duplicate", ["101", "101"]],
  ])("invalidates on %s sequences until a new snapshot", (_label, sequences) => {
    const book = new OrderBook();
    book.applySnapshot(observation("100", [["99", "1"]], [["101", "1"]]));
    for (const sequence of sequences) book.applyDelta(observation(sequence, [["99", "2"]], []));
    expect(book.status()).toBe("invalid");
    book.applyDelta(observation("104", [["99", "3"]], []));
    expect(book.status()).toBe("invalid");
    book.applySnapshot(observation("200", [["98", "4"]], [["102", "4"]]));
    expect(book.status()).toBe("valid");
    expect(book.levels("sell")).toEqual([{ price: "98", quantity: "4" }]);
  });

  it("supports sequence values above JavaScript's safe integer range", () => {
    const book = new OrderBook();
    book.applySnapshot(observation("99999999999999999", [["99", "1"]], [["101", "1"]]));
    book.applyDelta(observation("100000000000000000", [["99", "2"]], []));
    expect(book.status()).toBe("valid");
  });

  it("marks unsequenced feeds snapshot-only and requires a new snapshot after a delta", () => {
    const book = new OrderBook();
    book.applySnapshot(observation(undefined, [["99", "1"]], [["101", "1"]]));
    expect(book.status()).toBe("snapshot_only");
    book.applyDelta(observation(undefined, [["99", "2"]], []));
    expect(book.status()).toBe("invalid");
    book.applySnapshot(observation(undefined, [["98", "1"]], [["102", "1"]]));
    expect(book.status()).toBe("snapshot_only");
  });

  it("invalidates a delta from a different instrument without changing its visible levels", () => {
    const book = new OrderBook();
    book.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]]));
    book.applyDelta(observation("2", [["99", "2"]], [], { instrumentId: "ins_other" }));
    expect(book.status()).toBe("invalid");
    expect(book.levels("sell")).toEqual([]);
  });

  it("invalidates crossed books and leaves a prior valid snapshot unusable", () => {
    const book = new OrderBook();
    book.applySnapshot(observation("1", [["99", "1"]], [["101", "1"]]));
    book.applyDelta(observation("2", [["102", "1"]], []));
    expect(book.status()).toBe("invalid");
    expect(book.levels("buy")).toEqual([]);
  });

  it("rejects negative and non-finite levels at the schema boundary", () => {
    expect(() => observation("1", [["99", "-1"]], [])).toThrow();
    expect(() => observation("1", [["NaN", "1"]], [])).toThrow();
  });

  it("keeps generated monotonic books sorted and nonnegative", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const book = new OrderBook();
      book.applySnapshot(observation("0", [["99", "1"]], [["101", "1"]]));
      for (let sequence = 1; sequence <= 20; sequence++) {
        const bidPrice = `${90 + (seed * sequence) % 10}.${sequence % 10}`;
        const askPrice = `${101 + (seed * sequence) % 10}.${sequence % 10}`;
        book.applyDelta(observation(String(sequence), [[bidPrice, String((seed + sequence) % 4)]], [[askPrice, String((seed * sequence) % 4)]]));
        expect(book.status()).toBe("valid");
        const bids = book.levels("sell");
        const asks = book.levels("buy");
        expect(bids.every(level => Number(level.quantity) >= 0)).toBe(true);
        expect(asks.every(level => Number(level.quantity) >= 0)).toBe(true);
        expect(bids.map(level => Number(level.price))).toEqual([...bids].map(level => Number(level.price)).sort((a, b) => b - a));
        expect(asks.map(level => Number(level.price))).toEqual([...asks].map(level => Number(level.price)).sort((a, b) => a - b));
      }
    }
  });
});
