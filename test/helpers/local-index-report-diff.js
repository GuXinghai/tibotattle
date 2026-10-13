// Structural comparison of two projections: a v2 report against a committed
// golden, or a v2 reference against a v2 derivation of the same facts.
//
// Integers, strings and booleans must be identical. The one sanctioned
// difference (deviation N1 in the redesign plan) is binary-float money that
// accumulates event by event, so a rounded USD number may differ by one unit
// in the sixth decimal where float noise crosses a rounding boundary. Money
// carried as a decimal string is compared exactly.

const MONEY_KEYS = new Set(["apiPriceEquivalentUsd", "costUsd"]);
const TOLERANCE = 1.0000001e-6;

export function compareProjections(expected, actual, path = "$", differences = [], stats = { money: 0, exact: 0 }) {
  if (typeof expected === "number" && typeof actual === "number") {
    const key = path.split(".").at(-1).replace(/\[\d+\]$/u, "");
    if (MONEY_KEYS.has(key)) {
      stats.money += 1;
      // One unit in the sixth decimal, plus the spacing of doubles at this
      // magnitude: 1422.536612 - 1422.536611 is not exactly 1e-6.
      const slack = TOLERANCE + 8 * Number.EPSILON * Math.max(Math.abs(expected), Math.abs(actual));
      if (Math.abs(expected - actual) > slack) {
        differences.push({ path, expected, actual });
      }
    } else {
      stats.exact += 1;
      if (!Object.is(expected, actual)) differences.push({ path, expected, actual });
    }
    return differences;
  }
  if (expected === null || actual === null
      || typeof expected !== "object" || typeof actual !== "object") {
    stats.exact += 1;
    if (expected !== actual) differences.push({ path, expected, actual });
    return differences;
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    differences.push({ path, expected: "array-ness", actual: "array-ness" });
    return differences;
  }
  if (Array.isArray(expected)) {
    if (expected.length !== actual.length) {
      differences.push({ path: `${path}.length`, expected: expected.length, actual: actual.length });
      return differences;
    }
    for (let index = 0; index < expected.length; index += 1) {
      compareProjections(expected[index], actual[index], `${path}[${index}]`, differences, stats);
    }
    return differences;
  }
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    if (!(key in expected) || !(key in actual)) {
      differences.push({
        path: `${path}.${key}`,
        expected: key in expected ? "present" : "absent",
        actual: key in actual ? "present" : "absent",
      });
      continue;
    }
    compareProjections(expected[key], actual[key], `${path}.${key}`, differences, stats);
  }
  return differences;
}
