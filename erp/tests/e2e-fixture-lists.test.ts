import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { all, run } from "./helpers/source-lift";
import { itemTitle } from "@/lib/canvas-designer";
import { QUOTE_CONTRACT } from "@/lib/template-contracts/quote";
import type { CanvasItem } from "@/lib/template-contracts/canvas";

// The browser suite's fixture script, e2e/lib/db-fixtures.ts, writes its rows in create(), removes
// them by id in cleanup(), and at the start of each run finds by name whatever a killed run left
// behind (reapLeftovers()). A row that create() writes and one of the other two misses is found
// late or never. A container type missing from cleanup() fails nothing and stays in the database.
// A name missing from reapLeftovers() shows only in the run after a killed one, which CI never
// has: its database starts empty. So each list is read here from the script's source, parsed and
// never run, as tests/numbered-recipe-fixture-cleanup.test.ts reads it: the script is a command,
// and importing it runs it.
const source = ts.createSourceFile("db-fixtures.ts",
  readFileSync(new URL("../e2e/lib/db-fixtures.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);

/** A node's own text, with each run of white space as one space. */
const text = (node: ts.Node) => node.getText(source).replace(/\s+/g, " ");

/** The only one of `found`. None, or more than one, is a place this file can no longer read. */
function one<T>(found: T[], what: string): T {
  if (found.length !== 1) throw new Error(`${what}: ${found.length} in e2e/lib/db-fixtures.ts, expected 1`);
  return found[0];
}

/** A function of the script by its name, at the top level or inside another. */
const fn = (name: string) => one(all(source, ts.isFunctionDeclaration).filter((f) => f.name?.text === name), `function ${name}`);

/** The calls under `root` whose callee reads `callee`. */
const calls = (root: ts.Node, callee: string) => all(root, ts.isCallExpression).filter((call) => text(call.expression) === callee);

/** An object literal's properties, each name with its value's text. A spread is refused. */
function props(node: ts.Node): Record<string, string> {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`not an object literal: ${text(node)}`);
  return Object.fromEntries(node.properties.map((p) => {
    if (ts.isPropertyAssignment(p)) return [p.name.getText(source), text(p.initializer)];
    if (ts.isShorthandPropertyAssignment(p)) return [p.name.text, p.name.text];
    throw new Error(`not a plain property: ${text(p)}`);
  }));
}

/** The value of an object literal's property `name`, as a node. */
function prop(node: ts.Node, name: string): ts.Expression {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`not an object literal: ${text(node)}`);
  return one(node.properties.filter((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(source) === name),
    `property ${name} of ${text(node)}`).initializer;
}

/** An array literal's elements, as text. */
function items(node: ts.Node): string[] {
  if (!ts.isArrayLiteralExpression(node)) throw new Error(`not an array literal: ${text(node)}`);
  return node.elements.map(text);
}

/** The name of the `const` that an awaited call's answer is given to. */
function declaredAs(call: ts.CallExpression): string {
  const declaration = call.parent.parent;
  if (!ts.isAwaitExpression(call.parent) || !ts.isVariableDeclaration(declaration)) throw new Error(`not "const x = await …": ${text(call)}`);
  return declaration.name.getText(source);
}

// The script's own FIXTURE literal, evaluated with nothing else of the script in reach, so it must
// stay a plain literal, as the numbered-recipe test also needs.
const FIXTURE = run<Record<string, string>>(one(source.statements.filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations]).filter((d) => d.name.getText(source) === "FIXTURE"),
"const FIXTURE").initializer?.getText(source) ?? "undefined", {});

/** The value a list item written `FIXTURE.key` names. */
function fixtureValue(item: string): string {
  const value = FIXTURE[item.replace(/^FIXTURE\./, "")];
  if (!item.startsWith("FIXTURE.") || typeof value !== "string") throw new Error(`not a FIXTURE value: ${item}`);
  return value;
}

/** In reapLeftovers(): the part numbers looked up under the shipping customer. */
function shipPartLookup(): string[] {
  const where = one(all(fn("reapLeftovers"), ts.isObjectLiteralExpression).filter((o) => o.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText(source) === "customer" && text(p.initializer) === "{ code: FIXTURE.shipCustomerCode }")),
  "the part lookup under the shipping customer");
  return items(prop(prop(where, "partNumber"), "in"));
}

/** In cleanup(): the list handed to `callee` as its argument number `index`. */
const cleanupList = (callee: string, index: number) => items(one(calls(fn("cleanup"), callee), `${callee}( in cleanup()`).arguments[index]);

/** The fields of the payload that carry the three types and the bins part. */
const FIELDS = ["binTypeId", "binTypeName", "skidTypeId", "skidTypeName", "wireBasketTypeId", "wireBasketTypeName", "binsPartId", "binsPartNumber"];
const pick = (from: Record<string, string>) => Object.fromEntries(FIELDS.map((name) => [name, from[name]]));

describe("the fixture rows' names (e2e/lib/db-fixtures.ts)", () => {
  it("names the three container types and the bins part", () => {
    expect({ bin: FIXTURE.binTypeName, skid: FIXTURE.skidTypeName, wireBasket: FIXTURE.wireBasketTypeName, binsPart: FIXTURE.binsPartNumber })
      .toEqual({ bin: "E2E Bin", skid: "E2E Skid", wireBasket: "E2E Wire Basket", binsPart: "E2E-BINS-PART" });
  });

  it("keeps the tote type's name", () => {
    expect(FIXTURE.containerTypeName).toBe("E2E Tote");
  });

  it("lets no part number of the shipping customer begin with another", () => {
    // The part pickers click one option by a pattern anchored at the start of its text, in strict
    // mode (createOrderViaUi in e2e/lib/orders.mjs), so E2E-SHIP-A2 beside E2E-SHIP-A matches twice.
    const numbers = shipPartLookup().map(fixtureValue);
    expect(numbers.flatMap((a) => numbers.filter((b) => b !== a && b.startsWith(a)).map((b) => `${b} begins with ${a}`))).toEqual([]);
  });
});

describe("what create() writes and hands to the flows (e2e/lib/db-fixtures.ts)", () => {
  it("declares each type's id and name and the bins part's id and number as strings", () => {
    const alias = one(source.statements.filter((n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === "Fixtures"), "type Fixtures");
    const members = ts.isTypeLiteralNode(alias.type) ? alias.type.members.filter(ts.isPropertySignature) : [];
    expect(pick(Object.fromEntries(members.map((m) => [m.name.getText(source), m.type ? text(m.type) : ""]))))
      .toEqual(Object.fromEntries(FIELDS.map((name) => [name, "string"])));
  });

  it("returns each type's id and name and the bins part's id and number from create()", () => {
    const returned = one(all(fn("create"), ts.isReturnStatement).map((r) => r.expression)
      .filter((e): e is ts.ObjectLiteralExpression => e !== undefined && ts.isObjectLiteralExpression(e)), "create()'s returned object");
    expect(pick(props(returned))).toEqual({
      binTypeId: "binType.id", binTypeName: "binType.name",
      skidTypeId: "skidType.id", skidTypeName: "skidType.name",
      wireBasketTypeId: "wireBasketType.id", wireBasketTypeName: "wireBasketType.name",
      binsPartId: "binsPart.id", binsPartNumber: "binsPart.partNumber",
    });
  });

  it("creates four container types, and the bin alone with a tare each", () => {
    // E2E Tote must keep none: order-entry-workspace picks it and waits for both Tare cells of
    // order entry's Order totals table to read Incomplete, and discard-grid-edits picks it and
    // waits for the shipment row's Tare each box to be empty and for the Tare cell of the order's
    // and of the shipment's totals table to read Incomplete. pick-list-saves, the one flow that
    // writes the tote's tare each, runs after both and puts it back to none before it ends, or
    // fails.
    const created = Object.fromEntries(calls(fn("create"), "tx.containerType.create")
      .map((call) => [declaredAs(call), props(prop(call.arguments[0], "data"))]));
    expect(created).toEqual({
      toteType: { name: "FIXTURE.containerTypeName" },
      binType: { name: "FIXTURE.binTypeName", tareEach: '"310.00"' },
      skidType: { name: "FIXTURE.skidTypeName" },
      wireBasketType: { name: "FIXTURE.wireBasketTypeName" },
    });
  });

  it("creates the bins part under the shipping customer at 21.5 lb each", () => {
    const made = one(calls(fn("create"), "orderablePart").filter((call) => declaredAs(call) === "binsPart"), "const binsPart = await orderablePart(");
    expect(props(made.arguments[0])).toEqual({
      customerId: "shipCustomer.id", partNumber: "FIXTURE.binsPartNumber",
      name: '"E2E Bins Part"', eachWeight: '"21.5000"', certRequired: "false",
    });
  });

  it("gives orderablePart no load limit", () => {
    // With no load quantity and no load weight, splitLoads (src/lib/load-split.ts) puts an order of a part in one load.
    expect(fn("orderablePart").getText(source)).not.toMatch(/loadQty|loadWeight/);
  });
});

describe("what finds the rows again after a run that was killed (reapLeftovers)", () => {
  it("looks the bins part up under the shipping customer", () => {
    expect(new Set(shipPartLookup())).toEqual(new Set(
      ["FIXTURE.shipPartANumber", "FIXTURE.shipPartBNumber", "FIXTURE.certPartNumber", "FIXTURE.binsPartNumber"]));
  });

  it("looks all four container types up by name", () => {
    const lookup = one(calls(fn("reapLeftovers"), "prisma.containerType.findMany"), "prisma.containerType.findMany( in reapLeftovers()");
    expect(new Set(items(prop(prop(prop(lookup.arguments[0], "where"), "name"), "in")))).toEqual(new Set(
      ["FIXTURE.containerTypeName", "FIXTURE.binTypeName", "FIXTURE.skidTypeName", "FIXTURE.wireBasketTypeName"]));
  });
});

describe("what removes the rows after a run (cleanup)", () => {
  it.each(["deletePartProcessData", "deletePartPrices", "deletePartsAndCustomers"])("hands the bins part's id to %s", (callee) => {
    expect(cleanupList(callee, 0)).toContain("payload.binsPartId");
  });

  it("hands all four container type ids to deletePhase4Reference", () => {
    expect(new Set(cleanupList("deletePhase4Reference", 2))).toEqual(new Set(
      ["payload.containerTypeId", "payload.binTypeId", "payload.skidTypeId", "payload.wireBasketTypeId"]));
  });
});

// #587: the invoice-step-pick flow's own customer, part, step code and GL account. Each is written by
// create(), found again by reapLeftovers() and removed by cleanup(); a row any one of the three
// misses stays in the database, or blocks a delete after it.
const STEP_PICK_FIELDS = [
  "stepPickCustomerId", "stepPickCustomerCode", "stepPickPartId", "stepPickPartNumber",
  "stepPickStepCodeId", "stepPickStepCodeCode", "stepPickStepCodeName", "stepPickGlAccountId", "stepPickGlAccountName",
];

/** In create(): the data of the `callee` call whose answer is given to `name`. */
function createdData(callee: string, name: string): ts.Expression {
  return prop(one(calls(fn("create"), callee).filter((call) => declaredAs(call) === name), `const ${name} = await ${callee}(`).arguments[0], "data");
}

/** In reapLeftovers(): each name its `Promise.all` lookups are given, with the lookup call. */
function reapLookups(): Map<string, ts.CallExpression> {
  const declaration = one(all(fn("reapLeftovers"), ts.isVariableDeclaration).filter((d) => ts.isArrayBindingPattern(d.name)),
    "\"const [...] =\" in reapLeftovers()");
  const lookups = declaration.initializer;
  if (!ts.isArrayBindingPattern(declaration.name) || lookups === undefined || !ts.isAwaitExpression(lookups)
    || !ts.isCallExpression(lookups.expression) || text(lookups.expression.expression) !== "Promise.all") {
    throw new Error("reapLeftovers()'s lookups are not \"const [...] = await Promise.all([...])\"");
  }
  const names = declaration.name.elements.map((e) => (ts.isBindingElement(e) ? e.name.getText(source) : ""));
  const list = lookups.expression.arguments[0];
  if (!ts.isArrayLiteralExpression(list) || list.elements.length !== names.length) throw new Error("reapLeftovers()'s lookups and names do not pair up");
  return new Map(names.map((name, i) => {
    const call = list.elements[i];
    if (!ts.isCallExpression(call)) throw new Error(`lookup ${name} is not a call`);
    return [name, call];
  }));
}

/** In reapLeftovers(): whether `expression` carries the rows named `target`, through the function's
 *  own `const`s, arrays, spreads and `.map(...)` calls. */
function carries(expression: ts.Node, target: string, seen = new Set<string>()): boolean {
  if (ts.isIdentifier(expression)) {
    if (expression.text === target) return true;
    if (seen.has(expression.text)) return false;
    seen.add(expression.text);
    const declared = all(fn("reapLeftovers"), ts.isVariableDeclaration).filter((d) => ts.isIdentifier(d.name) && d.name.text === expression.text);
    return declared.length === 1 && declared[0].initializer !== undefined && carries(declared[0].initializer, target, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some((e) => carries(e, target, seen));
  if (ts.isSpreadElement(expression)) return carries(expression.expression, target, seen);
  if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "map") {
    return carries(expression.expression.expression, target, seen);
  }
  return false;
}

/** In reapLeftovers(): argument number `index` of its one call of `callee`. */
const reapArgument = (callee: string, index: number) => one(calls(fn("reapLeftovers"), callee), `${callee}( in reapLeftovers()`).arguments[index];

describe("the invoice-step-pick flow's rows (#587, e2e/lib/db-fixtures.ts)", () => {
  it("names its customer, part, step code and GL account", () => {
    expect({
      customer: FIXTURE.stepPickCustomerCode, part: FIXTURE.stepPickPartNumber,
      code: FIXTURE.stepPickStepCodeCode, name: FIXTURE.stepPickStepCodeName, gl: FIXTURE.stepPickGlAccountName,
    }).toEqual({ customer: "E2ESTEPCUST", part: "E2E-STEP-PICK", code: "E2E-AGE", name: "E2E Age Harden", gl: "E2E-4704" });
  });

  it("hands each row's id and name to the flows and to cleanup() (Fixtures, and CleanupPayload through it)", () => {
    const alias = (name: string) => one(source.statements.filter((n): n is ts.TypeAliasDeclaration => ts.isTypeAliasDeclaration(n) && n.name.text === name), `type ${name}`);
    const fixtures = alias("Fixtures").type;
    const members = ts.isTypeLiteralNode(fixtures) ? fixtures.members.filter(ts.isPropertySignature) : [];
    const declared = Object.fromEntries(members.map((m) => [m.name.getText(source), m.type ? text(m.type) : ""]));
    expect(Object.fromEntries(STEP_PICK_FIELDS.map((name) => [name, declared[name]]))).toEqual(Object.fromEntries(STEP_PICK_FIELDS.map((name) => [name, "string"])));
    expect(text(alias("CleanupPayload").type)).toMatch(/^Fixtures & /);
    const returned = props(one(all(fn("create"), ts.isReturnStatement).map((r) => r.expression)
      .filter((e): e is ts.ObjectLiteralExpression => e !== undefined && ts.isObjectLiteralExpression(e)), "create()'s returned object"));
    expect(Object.fromEntries(STEP_PICK_FIELDS.map((name) => [name, returned[name]]))).toEqual({
      stepPickCustomerId: "stepPickCustomer.id", stepPickCustomerCode: "stepPickCustomer.code",
      stepPickPartId: "stepPickPart.id", stepPickPartNumber: "stepPickPart.partNumber",
      stepPickStepCodeId: "stepPickStepCode.id", stepPickStepCodeCode: "stepPickStepCode.code",
      stepPickStepCodeName: "stepPickStepCode.name",
      stepPickGlAccountId: "stepPickGlAccount.id", stepPickGlAccountName: "stepPickGlAccount.name",
    });
  });

  it("creates an unpriced part whose one step is on a step code carrying the GL account, for a customer with no surcharge or tax", () => {
    expect(props(createdData("tx.customer.create", "stepPickCustomer"))).toEqual({
      code: "FIXTURE.stepPickCustomerCode", name: '"E2E Step Pick Customer"', taxable: "false", surchargeOptOut: "true",
    });
    expect(props(createdData("tx.glAccount.create", "stepPickGlAccount")).name).toBe("FIXTURE.stepPickGlAccountName");
    expect(props(createdData("tx.processStepCode.create", "stepPickStepCode"))).toEqual({
      code: "FIXTURE.stepPickStepCodeCode", name: "FIXTURE.stepPickStepCodeName", glAccountId: "stepPickGlAccount.id",
    });
    expect(props(createdData("tx.part.create", "stepPickPart"))).toMatchObject({
      customerId: "stepPickCustomer.id", partNumber: "FIXTURE.stepPickPartNumber", certRequired: "false",
    });
    expect(props(createdData("tx.partProcessRevision.create", "stepPickRevision"))).toEqual({ partId: "stepPickPart.id", revisionNumber: "1" });
    const steps = calls(fn("create"), "tx.partProcessStep.create").map((call) => props(prop(call.arguments[0], "data")))
      .filter((data) => data.revisionId === "stepPickRevision.id");
    expect(steps.map((data) => [data.position, data.codeId])).toEqual([["1", "stepPickStepCode.id"]]);
    // No price row: its invoice's operation line is the tier-3 Needs price line.
    expect(calls(fn("create"), "tx.partPrice.create").map((call) => props(prop(call.arguments[0], "data")).partId)).not.toContain("stepPickPart.id");
  });

  it("finds each row again in reapLeftovers(), by its exact natural key", () => {
    const lookups = reapLookups();
    const where = (name: string) => {
      const call = lookups.get(name);
      if (call === undefined) throw new Error(`no lookup named ${name}`);
      return prop(call.arguments[0], "where");
    };
    expect(text(lookups.get("stepPickCustomers")!.expression)).toBe("prisma.customer.findMany");
    expect(props(where("stepPickCustomers"))).toEqual({ code: "FIXTURE.stepPickCustomerCode" });
    expect(text(lookups.get("stepPickParts")!.expression)).toBe("prisma.part.findMany");
    expect(props(where("stepPickParts"))).toEqual({ partNumber: "FIXTURE.stepPickPartNumber", customer: "{ code: FIXTURE.stepPickCustomerCode }" });
    expect(items(prop(prop(where("stepCodes"), "code"), "in"))).toContain("FIXTURE.stepPickStepCodeCode");
    expect(items(prop(prop(where("invGlAccounts"), "name"), "in"))).toContain("FIXTURE.stepPickGlAccountName");
  });

  it.each([
    ["deleteInvoicesAndLines", 0, "stepPickCustomers"],
    ["deleteShippingAndCerts", 0, "stepPickCustomers"],
    ["deleteOrdersAndChildren", 0, "stepPickCustomers"],
    ["deletePartProcessData", 0, "stepPickParts"],
    ["deletePartPrices", 0, "stepPickParts"],
    ["deleteStepCodes", 0, "stepCodes"],
    ["deletePartsAndCustomers", 0, "stepPickParts"],
    ["deletePartsAndCustomers", 1, "stepPickCustomers"],
    ["deleteInvoicingReference", 0, "invGlAccounts"],
  ])("reapLeftovers() hands %s (argument %i) the rows of %s", (callee, index, rows) => {
    expect(carries(reapArgument(callee, index), rows)).toBe(true);
  });

  it.each([
    ["deleteInvoicesAndLines", 0, "payload.stepPickCustomerId"],
    ["deleteShippingAndCerts", 0, "payload.stepPickCustomerId"],
    ["deleteOrdersAndChildren", 0, "payload.stepPickCustomerId"],
    ["deletePartProcessData", 0, "payload.stepPickPartId"],
    ["deletePartPrices", 0, "payload.stepPickPartId"],
    ["deleteStepCodes", 0, "payload.stepPickStepCodeId"],
    ["deletePartsAndCustomers", 0, "payload.stepPickPartId"],
    ["deletePartsAndCustomers", 1, "payload.stepPickCustomerId"],
    ["deleteInvoicingReference", 0, "payload.stepPickGlAccountId"],
  ])("cleanup() hands %s (argument %i) %s", (callee, index, id) => {
    expect(cleanupList(callee, index)).toContain(id);
  });
});

// The main fixture customer's shipments and certs (ticket canvas PR 2b): the templates-admin flow
// ships its order to print a shipping ticket from its canvas template, so `deleteShippingAndCerts`
// takes that customer in both reapLeftovers() and cleanup(), or the shipment blocks the order delete
// after it (`ShipperOrder_orderId_fkey`'s RESTRICT). The rows follow the step-pick customers' above.
// Its invoice too (invoice canvas PR 3): the flow invoices that order, as a draft, to print an
// invoice from its canvas template, so `deleteInvoicesAndLines` takes the customer as well, or the
// invoice blocks the order delete (`Invoice.orderId` is RESTRICT). Its statements too (statement
// canvas PR 2): the flow prints that customer's statement from its canvas template, so
// `deleteStatementDocuments` takes the customer as well, or deleting the customer nulls the stored
// statement's `customerId` (`ON DELETE SET NULL`), which `StoredDocument_kind_owner_check` refuses.
describe("the main fixture customer's shipments, certs, invoice and statements (templates-admin, e2e/lib/db-fixtures.ts)", () => {
  it.each([
    ["deleteShippingAndCerts", 0, "customers"],
    ["deleteInvoicesAndLines", 0, "customers"],
    ["deleteStatementDocuments", 0, "customers"],
  ])("reapLeftovers() hands %s (argument %i) the rows of %s", (callee, index, rows) => {
    expect(carries(reapArgument(callee, index), rows)).toBe(true);
  });

  it.each([
    ["deleteShippingAndCerts", 0, "customerId"],
    ["deleteInvoicesAndLines", 0, "customerId"],
    ["deleteStatementDocuments", 0, "customerId"],
  ])("cleanup() hands %s (argument %i) %s", (callee, index, id) => {
    expect(cleanupList(callee, index)).toContain(id);
  });
});

// The templates the templates-admin flow makes through the screens (the bill of lading canvas's and
// the certification canvas's PR 2): each is reaped by name, through deleteDocumentTemplatesByName's
// default list, in both reapLeftovers() and cleanup(), which call it with no argument. A template
// the flow makes and the list misses stays in the database with its versions and its customer
// assignment after a killed run, and the next run's create refuses nothing, so the leftover shows
// nowhere. The flow's names are its top-level `…_TEMPLATE_NAME` constants, read from its source,
// parsed and never run.
describe("the templates-admin flow's own templates (e2e/flows/templates-admin.mjs, e2e/lib/db-fixtures.ts)", () => {
  const madeBy = (file: string) => {
    const flow = ts.createSourceFile(file,
      readFileSync(new URL(`../e2e/flows/${file}`, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
    return flow.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
      .filter((declaration) => /_TEMPLATE_NAME$/.test(declaration.name.getText(flow)))
      .map((declaration) => {
        const value = declaration.initializer;
        if (value === undefined || !ts.isStringLiteral(value)) throw new Error(`not a string literal: ${declaration.getText(flow)}`);
        return value.text;
      });
  };
  // The container-tags flow makes one too (container tag PR 1, Task 5).
  const made = [...madeBy("templates-admin.mjs"), ...madeBy("container-tags.mjs")];
  const reaped = () => {
    const names = one(fn("deleteDocumentTemplatesByName").parameters.filter((p) => p.name.getText(source) === "names"),
      "deleteDocumentTemplatesByName's names parameter").initializer;
    if (names === undefined) throw new Error("deleteDocumentTemplatesByName's names parameter has no default list");
    return items(names).map(fixtureValue);
  };

  it("names the bill of lading canvas template", () => {
    expect(FIXTURE.bolCanvasTemplateName).toBe("E2E BOL Canvas Template");
    expect(made).toContain(FIXTURE.bolCanvasTemplateName);
  });

  it("names the certification canvas template", () => {
    expect(FIXTURE.certCanvasTemplateName).toBe("E2E Cert Canvas Template");
    expect(made).toContain(FIXTURE.certCanvasTemplateName);
  });

  it("names the invoice canvas template", () => {
    expect(FIXTURE.invoiceCanvasTemplateName).toBe("E2E Invoice Canvas Template");
    expect(made).toContain(FIXTURE.invoiceCanvasTemplateName);
  });

  it("names the statement canvas template", () => {
    expect(FIXTURE.statementCanvasTemplateName).toBe("E2E Statement Canvas Template");
    expect(made).toContain(FIXTURE.statementCanvasTemplateName);
  });

  it("names the quote canvas template, and reaps it by name", () => {
    expect(FIXTURE.quoteCanvasTemplateName).toBe("E2E Quote Canvas Template");
    expect(made).toContain(FIXTURE.quoteCanvasTemplateName);
    expect(reaped()).toContain(FIXTURE.quoteCanvasTemplateName);
  });

  it("names the container tag template the container-tags flow makes, and reaps it by name", () => {
    expect(FIXTURE.containerTagTemplateName).toBe("E2E Container Tag Template");
    expect(madeBy("container-tags.mjs")).toEqual([FIXTURE.containerTagTemplateName]);
    expect(reaped()).toContain(FIXTURE.containerTagTemplateName);
  });

  it("reaps by name exactly the templates the flows make", () => {
    expect([...reaped()].sort()).toEqual([...made].sort());
  });

  it.each(["cleanup", "reapLeftovers"])("%s() makes exactly one deleteDocumentTemplatesByName call, with no argument, so the default list is what it reaps", (name) => {
    const found = calls(fn(name), "deleteDocumentTemplatesByName");
    expect(found).toHaveLength(1);
    expect(found[0].arguments).toHaveLength(0);
  });
});

// The quote's canvas items the templates-admin flow waits for by name (quote canvas PR 2). Plain node,
// which runs the flow, cannot load the contract (its relative imports carry no ending), so the flow
// holds the names as two top-level arrays of string literals, and this case holds them to the names
// the stage gives the seeded items: each header field item by its field's name, each block by its
// section's name (`itemTitle`), in the contract's order. Read from the flow's source, parsed and never
// run.
describe("the templates-admin flow's quote canvas item names (e2e/flows/templates-admin.mjs)", () => {
  const flow = ts.createSourceFile("templates-admin.mjs",
    readFileSync(new URL("../e2e/flows/templates-admin.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const literals = (name: string) => {
    const found = flow.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
      .filter((d) => d.name.getText(flow) === name);
    if (found.length !== 1) throw new Error(`const ${name}: ${found.length} at the top level of e2e/flows/templates-admin.mjs, expected 1`);
    const declaration = found[0];
    const value = declaration.initializer;
    if (value === undefined || !ts.isArrayLiteralExpression(value)) throw new Error(`not an array literal: ${declaration.getText(flow)}`);
    return value.elements.map((element) => {
      if (!ts.isStringLiteral(element)) throw new Error(`not a string literal: ${element.getText(flow)}`);
      return element.text;
    });
  };
  const title = (kind: "field" | "table", key: string) => itemTitle({ kind, key } as CanvasItem, QUOTE_CONTRACT);
  const header = QUOTE_CONTRACT.sections.find((s) => s.key === "header")!;

  it("names the header's four field items by their fields' names", () => {
    expect(literals("QUOTE_CANVAS_FIELDS")).toEqual(header.fields.map((f) => title("field", f.key)));
  });

  it("names the six blocks by their sections' names, in the contract's order", () => {
    expect(literals("QUOTE_CANVAS_BLOCKS")).toEqual(QUOTE_CONTRACT.sections.filter((s) => s !== header).map((s) => title("table", s.key)));
  });
});
