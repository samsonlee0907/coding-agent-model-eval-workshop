#!/usr/bin/env node
/**
 * Conformance probe for `in-memory-ordering-system-v1`.
 *
 * Run as: node probe.mjs <check-id>   (cwd must be the delivered workspace)
 * Exits 0 when the expectation held, 1 when it did not, 2 on a probe/usage error.
 *
 * This file is owned by the task author and is never shown to the agent, so a
 * passing check is evidence about the delivered code rather than about the
 * tests the candidate chose to write.
 *
 * It depends only on what the task prompt explicitly specifies: the package's
 * own declared entry point, an exported `OrderStore` constructor, the six named
 * methods, and the `id` / `status` fields. It deliberately does not inspect line
 * item internals, which the prompt leaves to the implementer.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const STATUS = { pending: "pending", paid: "paid", fulfilled: "fulfilled", cancelled: "cancelled" };

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message);
}

function assert(condition, message) {
  if (!condition) {
    fail(message);
  }
}

/** Asserts that `fn` throws. A silent success is the defect this catches. */
function assertRejects(fn, message) {
  let threw = false;
  try {
    fn();
  } catch (error) {
    threw = true;
    assert(error instanceof Error, `${message} - it threw a non-Error value (${typeof error}).`);
  }
  assert(threw, message);
}

/**
 * Resolves the package's own declared entry point, exactly as an external
 * consumer would. A package whose manifest points at a file the build never
 * emits is unusable no matter how many of its own tests pass.
 */
function resolveEntry(root) {
  const manifestPath = join(root, "package.json");
  if (!existsSync(manifestPath)) {
    fail("The delivered workspace has no package.json, so the module cannot be imported by any consumer.");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = [manifest.main, manifest.module, pickExport(manifest.exports)].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
  const candidates = declared.length > 0 ? declared : ["index.js", "dist/index.js", "src/index.js"];
  for (const candidate of candidates) {
    const resolved = resolveWithExtensions(join(root, candidate));
    if (resolved !== null) {
      return { path: resolved, declared: candidate, wasDeclared: declared.length > 0 };
    }
  }
  fail(
    declared.length > 0
      ? `The manifest declares entry point(s) ${declared.map((value) => `"${value}"`).join(", ")}, but no such file exists in the delivered artifact.`
      : "The manifest declares no entry point and no conventional index file exists, so the module cannot be imported.",
  );
}

function pickExport(exported) {
  if (typeof exported === "string") {
    return exported;
  }
  if (exported === null || typeof exported !== "object") {
    return null;
  }
  const root = exported["."] ?? exported;
  if (typeof root === "string") {
    return root;
  }
  if (root && typeof root === "object") {
    for (const key of ["import", "require", "default", "node"]) {
      const value = root[key];
      if (typeof value === "string") {
        return value;
      }
    }
  }
  return null;
}

function resolveWithExtensions(path) {
  const candidates = [path, `${path}.js`, `${path}.mjs`, `${path}.cjs`, join(path, "index.js"), join(path, "index.mjs")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Finds the exported OrderStore constructor without assuming an export style. */
async function loadStoreConstructor(root) {
  const entry = resolveEntry(root);
  let module;
  try {
    module = await import(pathToFileURL(entry.path).href);
  } catch (error) {
    fail(`Importing the declared entry point "${entry.declared}" threw: ${error.message}`);
  }
  const namespaces = [module, module.default].filter((value) => value && typeof value === "object");
  for (const namespace of namespaces) {
    const found = namespace.OrderStore ?? namespace.orderStore;
    if (typeof found === "function") {
      return found;
    }
  }
  if (typeof module.default === "function" && module.default.name === "OrderStore") {
    return module.default;
  }
  const exported = Object.keys(module).join(", ") || "(nothing)";
  fail(`The entry point "${entry.declared}" does not export an \`OrderStore\` constructor. It exports: ${exported}.`);
}

function newStore(Store) {
  try {
    return new Store();
  } catch (error) {
    fail(`\`new OrderStore()\` threw: ${error.message}`);
  }
}

function requireMethods(store) {
  const required = ["createOrder", "addItem", "removeItem", "orderTotal", "updateStatus", "listOrders"];
  const missing = required.filter((name) => typeof store[name] !== "function");
  if (missing.length > 0) {
    fail(`The OrderStore instance is missing required method(s): ${missing.join(", ")}.`);
  }
}

function orderId(created) {
  if (created && typeof created === "object" && "id" in created) {
    return created.id;
  }
  if (typeof created === "string" || typeof created === "number") {
    return created;
  }
  fail("createOrder did not return an object carrying an `id`.");
}

function itemCount(order) {
  const items = order?.items;
  if (items === undefined || items === null) {
    return 0;
  }
  if (Array.isArray(items)) {
    return items.length;
  }
  if (items instanceof Map || items instanceof Set) {
    return items.size;
  }
  if (typeof items === "object") {
    return Object.keys(items).length;
  }
  return 0;
}

const checks = {
  "entry-resolves": async (root) => {
    const Store = await loadStoreConstructor(root);
    const store = newStore(Store);
    requireMethods(store);
  },

  "create-order": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const first = store.createOrder("cust-1");
    const second = store.createOrder("cust-2");
    assert(first !== undefined && first !== null, "createOrder returned nothing.");
    const firstId = orderId(first);
    const secondId = orderId(second);
    assert(firstId !== undefined && firstId !== null && `${firstId}`.length > 0, "createOrder produced an empty id.");
    assert(firstId !== secondId, `createOrder produced duplicate ids (${firstId}).`);
    assert(
      first.status === STATUS.pending,
      `A new order's status must be "pending"; got ${JSON.stringify(first.status)}.`,
    );
    assert(itemCount(first) === 0, "A new order must start with no items.");
  },

  "total-merges-skus": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const id = orderId(store.createOrder("cust-1"));
    store.addItem(id, "SKU-A", 10, 2);
    store.addItem(id, "SKU-B", 2.5, 4);
    assert(store.orderTotal(id) === 30, `Expected a total of 30 for 10x2 + 2.5x4; got ${store.orderTotal(id)}.`);

    // Adding the same SKU again must increase quantity, not duplicate the line.
    store.addItem(id, "SKU-A", 10, 3);
    const total = store.orderTotal(id);
    assert(
      total === 60,
      `Adding SKU-A twice (2 then 3 at 10 each) plus SKU-B (2.5x4) must total 60; got ${total}. A duplicated line item or a replaced quantity produces a different figure.`,
    );

    store.removeItem(id, "SKU-B");
    assert(store.orderTotal(id) === 50, `After removing SKU-B the total must be 50; got ${store.orderTotal(id)}.`);
  },

  "rejects-bad-input": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const id = orderId(store.createOrder("cust-1"));
    store.addItem(id, "SKU-A", 10, 2);
    const baseline = store.orderTotal(id);

    assertRejects(() => store.addItem(id, "SKU-B", 5, 0), "addItem must reject a quantity of 0.");
    assertRejects(() => store.addItem(id, "SKU-B", 5, -1), "addItem must reject a negative quantity.");
    assertRejects(() => store.addItem(id, "SKU-B", 5, 1.5), "addItem must reject a non-integer quantity.");
    assertRejects(() => store.addItem(id, "SKU-B", -5, 1), "addItem must reject a negative unitPrice.");

    assert(
      store.orderTotal(id) === baseline,
      `A rejected addItem must leave existing state intact; the total moved from ${baseline} to ${store.orderTotal(id)}.`,
    );
  },

  "status-machine": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const happy = orderId(store.createOrder("cust-1"));
    store.updateStatus(happy, STATUS.paid);
    store.updateStatus(happy, STATUS.fulfilled);
    assertRejects(
      () => store.updateStatus(happy, STATUS.cancelled),
      "A fulfilled order must reject any further status transition, including cancel.",
    );

    const skipper = orderId(store.createOrder("cust-2"));
    assertRejects(
      () => store.updateStatus(skipper, STATUS.fulfilled),
      "pending -> fulfilled must be rejected; the order must be paid first.",
    );

    const cancelledFromPending = orderId(store.createOrder("cust-3"));
    store.updateStatus(cancelledFromPending, STATUS.cancelled);
    assertRejects(
      () => store.updateStatus(cancelledFromPending, STATUS.cancelled),
      "Re-cancelling an already cancelled order must be rejected.",
    );

    const cancelledFromPaid = orderId(store.createOrder("cust-4"));
    store.updateStatus(cancelledFromPaid, STATUS.paid);
    store.updateStatus(cancelledFromPaid, STATUS.cancelled);
  },

  "terminal-guard": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    for (const terminal of [STATUS.fulfilled, STATUS.cancelled]) {
      const id = orderId(store.createOrder("cust-1"));
      store.addItem(id, "SKU-A", 10, 1);
      if (terminal === STATUS.fulfilled) {
        store.updateStatus(id, STATUS.paid);
        store.updateStatus(id, STATUS.fulfilled);
      } else {
        store.updateStatus(id, STATUS.cancelled);
      }
      assertRejects(() => store.addItem(id, "SKU-B", 5, 1), `A ${terminal} order must reject addItem.`);
      assertRejects(() => store.removeItem(id, "SKU-A"), `A ${terminal} order must reject removeItem.`);
    }
  },

  "list-filter": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const pendingId = orderId(store.createOrder("cust-1"));
    const paidId = orderId(store.createOrder("cust-2"));
    store.updateStatus(paidId, STATUS.paid);

    const all = store.listOrders();
    assert(Array.isArray(all), "listOrders() must return an array.");
    assert(all.length === 2, `listOrders() must return every order; expected 2, got ${all.length}.`);

    const paidOnly = store.listOrders(STATUS.paid);
    assert(Array.isArray(paidOnly), "listOrders(status) must return an array.");
    assert(
      paidOnly.length === 1 && `${orderId(paidOnly[0])}` === `${paidId}`,
      `listOrders("paid") must return exactly the paid order; got ${paidOnly.length} result(s).`,
    );

    const pendingOnly = store.listOrders(STATUS.pending);
    assert(
      pendingOnly.length === 1 && `${orderId(pendingOnly[0])}` === `${pendingId}`,
      `listOrders("pending") must return exactly the pending order; got ${pendingOnly.length} result(s).`,
    );
  },

  "unknown-id": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const missing = "no-such-order-id";
    assertRejects(() => store.addItem(missing, "SKU-A", 10, 1), "addItem on an unknown order id must throw.");
    assertRejects(() => store.removeItem(missing, "SKU-A"), "removeItem on an unknown order id must throw.");
    assertRejects(() => store.orderTotal(missing), "orderTotal on an unknown order id must throw.");
    assertRejects(() => store.updateStatus(missing, STATUS.paid), "updateStatus on an unknown order id must throw.");
  },

  // Advisory: the prompt does not require defensive copying, but a store that
  // hands out live internal state is a real hazard worth surfacing as a signal
  // rather than a failure.
  "no-state-leak": async (root) => {
    const store = newStore(await loadStoreConstructor(root));
    const id = orderId(store.createOrder("cust-1"));
    store.addItem(id, "SKU-A", 10, 2);
    const before = store.orderTotal(id);

    const [listed] = store.listOrders();
    if (listed && typeof listed === "object") {
      try {
        listed.status = "tampered";
        if (Array.isArray(listed.items)) {
          listed.items.push({ sku: "INJECTED", unitPrice: 999, quantity: 1 });
        }
      } catch {
        // A frozen or proxied order is exactly the desired behaviour.
      }
    }

    const after = store.orderTotal(id);
    assert(
      after === before,
      `Mutating an object returned by listOrders() changed the store's total from ${before} to ${after}; internal state is escaping through returned references.`,
    );
    const [again] = store.listOrders(STATUS.pending);
    assert(
      again !== undefined,
      "After mutating a returned order, listOrders(\"pending\") no longer finds it; the returned object aliases internal state.",
    );
  },
};

const checkId = process.argv[2];
if (!checkId) {
  console.error(`Usage: node probe.mjs <check-id>\nAvailable: ${Object.keys(checks).join(", ")}`);
  process.exit(2);
}
const check = checks[checkId];
if (!check) {
  console.error(`Unknown check "${checkId}". Available: ${Object.keys(checks).join(", ")}`);
  process.exit(2);
}

try {
  await check(resolve(process.cwd()));
  console.log(`PASS ${checkId}`);
  process.exit(0);
} catch (error) {
  if (error instanceof CheckFailure) {
    console.error(`FAIL ${checkId}: ${error.message}`);
    process.exit(1);
  }
  // An unexpected throw from the delivered code is still evidence against it:
  // the probe only calls operations the task prompt specifies.
  console.error(`FAIL ${checkId}: the delivered code threw unexpectedly - ${error?.stack ?? error}`);
  process.exit(1);
}
