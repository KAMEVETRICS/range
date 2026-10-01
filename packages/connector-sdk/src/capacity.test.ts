import { expect, it } from "vitest";
import { visibleCapacityUsd } from "./capacity.js";

it("takes the smaller side's visible notional, rounded down to cents", () => {
  expect(visibleCapacityUsd([{ price: "100", quantity: "2" }, { price: "99.5", quantity: "1.005" }],
    [{ price: "100.1", quantity: "1" }])).toBe("100.1");
  expect(visibleCapacityUsd([{ price: "228.26", quantity: "0.333" }], [{ price: "228.3", quantity: "10" }])).toBe("76.01");
  expect(visibleCapacityUsd([], [{ price: "1", quantity: "1" }])).toBe("0");
});
