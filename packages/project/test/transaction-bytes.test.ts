import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";

import { FileStore } from "../src/files/file-store";
import { readBoundedProjectBytes } from "../src/files/private-byte-io";
import { FileProjectTransactionStateStore } from "../src/persistence/transaction-state";
import { createProjectKernel } from "../src/runtime/project-kernel";
import { encodePreservingProjectBytes } from "../src/transactions/byte-codec";
import {
  decodeProjectTextBuffer,
  encodeProjectTextBuffer,
} from "../src/utils/text";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "project-private-bytes-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const original = Buffer.concat([
  Buffer.from([0x80]),
  Buffer.from(" old\r\n"),
  Buffer.from([0xfe, 0x59]),
  Buffer.from(" middle\n"),
  Buffer.from([0x80]),
]);
const modified = Buffer.concat([
  Buffer.from([0x80]),
  Buffer.from(" new\r\n"),
  Buffer.from([0xfe, 0x59]),
  Buffer.from(" middle\n"),
  Buffer.from([0x80]),
]);
const replace = (path = "a.txt") => ({
  operation: {
    type: "replace_text" as const,
    path,
    oldText: "old",
    newText: "new",
  },
});
async function fixture(durable: boolean) {
  await writeFile(join(root, "a.txt"), original);
  await chmod(join(root, "a.txt"), 0o640);
  const transactionStatePath = durable
    ? join(root, ".private", "transactions.json")
    : undefined;
  const kernel = await createProjectKernel({ root, transactionStatePath });
  return { kernel, transactionStatePath };
}

test.each([false, true])(
  "byte aliases and mixed newlines survive edit, undo, and replay; durable=%s",
  async (durable) => {
    const { kernel, transactionStatePath } = await fixture(durable);
    const prepared = await kernel.prepareEdit({ operations: [replace()] });
    await kernel.applyEdit({ transactionId: prepared.transactionId });
    expect(await readFile(join(root, "a.txt"))).toEqual(modified);
    expect((await stat(join(root, "a.txt"))).mode & 0o777).toBe(0o640);
    const publicObjects = JSON.stringify([
      prepared,
      kernel.getTransaction(prepared.transactionId),
      await kernel.read({ path: "a.txt" }),
      kernel.changeFeed.get(prepared.transactionId),
    ]);
    expect(publicObjects).not.toContain("bytePlans");
    expect(publicObjects).not.toContain("transactionBytes");
    expect(publicObjects).not.toContain(original.toString("base64"));
    if (transactionStatePath) {
      const privateState = JSON.parse(
        await readFile(transactionStatePath, "utf8"),
      );
      expect(privateState.formatVersion).toBe(2);
      expect(privateState.bytePlans[0].patches[0].before).toBe(
        original.toString("base64"),
      );
    }
    const current = transactionStatePath
      ? await createProjectKernel({ root, transactionStatePath })
      : kernel;
    await current.rollback({ transactionId: prepared.transactionId });
    expect(await readFile(join(root, "a.txt"))).toEqual(original);
    await current.applyEdit({ transactionId: prepared.transactionId });
    expect(await readFile(join(root, "a.txt"))).toEqual(modified);
  },
);

test("rename chains and deleted paths retain exact original bytes after reopen and undo", async () => {
  const { kernel, transactionStatePath } = await fixture(true);
  const tx = await kernel.prepareEdit({
    operations: [
      { operation: { type: "rename_file", from: "a.txt", to: "middle.txt" } },
      {
        operation: { type: "rename_file", from: "middle.txt", to: "final.txt" },
      },
      {
        operation: {
          type: "create_file",
          path: "a.txt",
          content: "new identity\n",
        },
      },
    ],
  });
  await kernel.applyEdit({ transactionId: tx.transactionId });
  expect(await readFile(join(root, "final.txt"))).toEqual(original);
  const reopened = await createProjectKernel({ root, transactionStatePath });
  await reopened.rollback({ transactionId: tx.transactionId });
  expect(await readFile(join(root, "a.txt"))).toEqual(original);
  expect(await Bun.file(join(root, "final.txt")).exists()).toBe(false);
});

test.each([false, true])(
  "a failure after a write restores exact bytes across all files; durable=%s",
  async (durable) => {
    const { kernel } = await fixture(durable);
    await writeFile(join(root, "b.txt"), original);
    const tx = await kernel.prepareEdit({
      operations: [replace(), replace("b.txt")],
    });
    const write = FileStore.prototype.write;
    let fail = true;
    const hook = spyOn(FileStore.prototype, "write").mockImplementation(
      async function (this: FileStore, ...args: Parameters<typeof write>) {
        const result = await write.apply(this, args);
        if (fail && args[0] === "b.txt") {
          fail = false;
          throw new Error("after write");
        }
        return result;
      },
    );
    try {
      await expect(
        kernel.applyEdit({ transactionId: tx.transactionId }),
      ).rejects.toThrow("after write");
      expect(await readFile(join(root, "a.txt"))).toEqual(original);
      expect(await readFile(join(root, "b.txt"))).toEqual(original);
      await kernel.applyEdit({ transactionId: tx.transactionId });
      expect(await readFile(join(root, "b.txt"))).toEqual(modified);
    } finally {
      hook.mockRestore();
    }
  },
);

test("preflight byte CAS rejects a same-text external encoding change without overwriting it", async () => {
  const { kernel } = await fixture(false);
  const tx = await kernel.prepareEdit({ operations: [replace()] });
  const write = FileStore.prototype.write;
  const external = encodeProjectTextBuffer(
    decodeProjectTextBuffer(original)!,
    "gb18030",
  );
  let changed = false;
  const hook = spyOn(FileStore.prototype, "write").mockImplementation(
    async function (this: FileStore, ...args: Parameters<typeof write>) {
      if (!changed) {
        changed = true;
        await writeFile(join(root, "a.txt"), external);
      }
      return write.apply(this, args);
    },
  );
  try {
    await expect(
      kernel.applyEdit({ transactionId: tx.transactionId }),
    ).rejects.toThrow();
    expect(await readFile(join(root, "a.txt"))).toEqual(external);
  } finally {
    hook.mockRestore();
  }
});

test("undo rejects external same-Unicode byte changes before touching any file", async () => {
  const { kernel } = await fixture(false);
  await writeFile(join(root, "b.txt"), original);
  const tx = await kernel.prepareEdit({
    operations: [replace(), replace("b.txt")],
  });
  await kernel.applyEdit({ transactionId: tx.transactionId });
  const external = encodeProjectTextBuffer(
    decodeProjectTextBuffer(modified)!,
    "gb18030",
  );
  await writeFile(join(root, "a.txt"), external);
  await expect(
    kernel.rollback({ transactionId: tx.transactionId }),
  ).rejects.toThrow("字节");
  expect(await readFile(join(root, "a.txt"))).toEqual(external);
  expect(await readFile(join(root, "b.txt"))).toEqual(modified);
});

test("version 1 state loads and upgrades on the next durable commit", async () => {
  const { kernel, transactionStatePath } = await fixture(true);
  await kernel.prepareEdit({ operations: [replace()] });
  const state = JSON.parse(await readFile(transactionStatePath!, "utf8"));
  state.formatVersion = 1;
  delete state.bytePlans;
  await writeFile(transactionStatePath!, JSON.stringify(state));
  const reopened = await createProjectKernel({ root, transactionStatePath });
  await reopened.applyEdit({
    transactionId: state.transactions[0].transactionId,
  });
  expect(
    JSON.parse(await readFile(transactionStatePath!, "utf8")).formatVersion,
  ).toBe(2);
});

test("interrupted apply restores raw backups from the private write-ahead state", async () => {
  const { kernel, transactionStatePath } = await fixture(true);
  const tx = await kernel.prepareEdit({ operations: [replace()] });
  let pending:
    ReturnType<FileProjectTransactionStateStore["snapshot"]> | undefined;
  const commit = FileProjectTransactionStateStore.prototype.commit;
  const hook = spyOn(
    FileProjectTransactionStateStore.prototype,
    "commit",
  ).mockImplementation(function (
    this: FileProjectTransactionStateStore,
    input,
  ) {
    const result = commit.call(this, input);
    if (input.pending) pending = result;
    return result;
  });
  try {
    await kernel.applyEdit({ transactionId: tx.transactionId });
  } finally {
    hook.mockRestore();
  }
  expect(pending?.pending).toBeDefined();
  await writeFile(transactionStatePath!, JSON.stringify(pending));
  const reopened = await createProjectKernel({ root, transactionStatePath });
  expect(await readFile(join(root, "a.txt"))).toEqual(original);
  expect(reopened.getTransaction(tx.transactionId)?.status).toBe("validated");
  await reopened.applyEdit({ transactionId: tx.transactionId });
  expect(await readFile(join(root, "a.txt"))).toEqual(modified);
});

test("the framework adds a same-endian BOM when short UTF16 loses encoding evidence", async () => {
  const path = join(root, "a.txt");
  const bytes = encodeProjectTextBuffer(
    "ascii enough source 中文\n",
    "utf16le-nobom",
  );
  await writeFile(path, bytes);
  const kernel = await createProjectKernel({ root });
  const tx = await kernel.prepareEdit({
    operations: [
      {
        operation: {
          type: "replace_text",
          path: "a.txt",
          oldText: "ascii enough source 中文\n",
          newText: "中文",
        },
      },
    ],
  });
  await kernel.applyEdit({ transactionId: tx.transactionId });
  expect((await kernel.read({ path: "a.txt" })).content).toBe("中文");
  expect(await readFile(path)).toEqual(
    encodeProjectTextBuffer("中文", "utf16le"),
  );
  await kernel.rollback({ transactionId: tx.transactionId });
  expect(await readFile(path)).toEqual(bytes);
});

test("large disjoint byte edits have a bounded fallback and retain edge aliases", () => {
  const before = `€${"a".repeat(120000)}龴`;
  const after = `€${"b".repeat(120000)}龴`;
  const bytes = Buffer.concat([
    Buffer.from([0x80]),
    Buffer.from("a".repeat(120000)),
    Buffer.from([0xfe, 0x59]),
  ]);
  const started = Date.now();
  const output = encodePreservingProjectBytes(bytes, before, after, "gb18030");
  expect(Date.now() - started).toBeLessThan(2000);
  expect(output[0]).toBe(0x80);
  expect(output.subarray(-2)).toEqual(Buffer.from([0xfe, 0x59]));
  expect(decodeProjectTextBuffer(output)).toBe(after);
});

test("delete checks bytes inside the final mutation port", async () => {
  const { kernel } = await fixture(false);
  const tx = await kernel.prepareEdit({
    operations: [{ operation: { type: "delete_file", path: "a.txt" } }],
  });
  const remove = FileStore.prototype.remove;
  const external = Buffer.from("external edit\n");
  let changed = false;
  const hook = spyOn(FileStore.prototype, "remove").mockImplementation(
    async function (this: FileStore, ...args: Parameters<typeof remove>) {
      if (!changed) {
        changed = true;
        await writeFile(join(root, "a.txt"), external);
      }
      return remove.apply(this, args);
    },
  );
  try {
    await expect(
      kernel.applyEdit({ transactionId: tx.transactionId }),
    ).rejects.toThrow();
    expect(await readFile(join(root, "a.txt"))).toEqual(external);
  } finally {
    hook.mockRestore();
  }
});

test.each(["before", "after"] as const)(
  "state validation rejects a present byte plan missing %s",
  async (field) => {
    const { kernel, transactionStatePath } = await fixture(true);
    const tx = await kernel.prepareEdit({ operations: [replace()] });
    await kernel.applyEdit({ transactionId: tx.transactionId });
    const state = JSON.parse(await readFile(transactionStatePath!, "utf8"));
    delete state.bytePlans[0].patches[0][field];
    await writeFile(transactionStatePath!, JSON.stringify(state));
    expect(
      () =>
        new FileProjectTransactionStateStore({
          path: transactionStatePath!,
          root,
        }),
    ).toThrow(`byte plan ${field} presence`);
  },
);

async function failOneApply(
  kernel: Awaited<ReturnType<typeof createProjectKernel>>,
  transactionId: string,
) {
  const write = FileStore.prototype.write;
  let failed = false;
  const hook = spyOn(FileStore.prototype, "write").mockImplementation(
    async function (this: FileStore, ...args: Parameters<typeof write>) {
      const result = await write.apply(this, args);
      if (!failed) {
        failed = true;
        throw new Error("write receipt lost");
      }
      return result;
    },
  );
  try {
    await expect(kernel.applyEdit({ transactionId })).rejects.toThrow(
      "write receipt lost",
    );
  } finally {
    hook.mockRestore();
  }
}

test("discard clears failed-attempt byte plans without retaining private source", async () => {
  const { kernel, transactionStatePath } = await fixture(true);
  const tx = await kernel.prepareEdit({ operations: [replace()] });
  await failOneApply(kernel, tx.transactionId);
  expect((kernel as any).transactionRecovery.captureBytePlans().size).toBe(1);
  kernel.discardTransaction(tx.transactionId);
  expect((kernel as any).transactionRecovery.captureBytePlans().size).toBe(0);
  expect(
    JSON.parse(await readFile(transactionStatePath!, "utf8")).bytePlans,
  ).toEqual([]);
});

test("amend after failed apply invalidates the previous byte plan and prepares the new chain", async () => {
  const { kernel, transactionStatePath } = await fixture(true);
  const tx = await kernel.prepareEdit({ operations: [replace()] });
  await failOneApply(kernel, tx.transactionId);
  await kernel.amendEdit({
    transactionId: tx.transactionId,
    operations: [
      {
        operation: {
          type: "replace_text",
          path: "a.txt",
          oldText: "middle",
          newText: "center",
        },
      },
    ],
  });
  expect(
    JSON.parse(await readFile(transactionStatePath!, "utf8")).bytePlans,
  ).toEqual([]);
  await kernel.applyEdit({ transactionId: tx.transactionId });
  await kernel.rollback({ transactionId: tx.transactionId });
  expect(await readFile(join(root, "a.txt"))).toEqual(original);
});

test("failed publication after eviction restores the previous private undo plan", async () => {
  const { kernel } = await fixture(true);
  const tx = await kernel.prepareEdit({ operations: [replace()] });
  await kernel.applyEdit({ transactionId: tx.transactionId });
  // 将测试仓库保留上限缩到 1，触发与生产上限相同的淘汰路径。
  (kernel as any).transactionRepository.options.maxTransactions = 1;
  const commit = FileProjectTransactionStateStore.prototype.commit;
  let fail = true;
  const hook = spyOn(
    FileProjectTransactionStateStore.prototype,
    "commit",
  ).mockImplementation(function (
    this: FileProjectTransactionStateStore,
    input,
  ) {
    if (fail) {
      fail = false;
      throw new Error("state unavailable");
    }
    return commit.call(this, input);
  });
  try {
    await expect(
      kernel.prepareEdit({
        operations: [
          {
            operation: {
              type: "replace_text",
              path: "a.txt",
              oldText: "new",
              newText: "third",
            },
          },
        ],
      }),
    ).rejects.toThrow("state unavailable");
    await kernel.rollback({ transactionId: tx.transactionId });
    expect(await readFile(join(root, "a.txt"))).toEqual(original);
  } finally {
    hook.mockRestore();
  }
});

test("private raw reads reject external growth before allocating an oversized body", async () => {
  const path = join(root, "large.txt");
  await writeFile(path, "old");
  await truncate(path, 64 * 1024 * 1024);
  await expect(readBoundedProjectBytes(path, 3)).rejects.toThrow("字节长度");
  const store = new FileStore(root, {
    ...((await createProjectKernel({ root })) as any).policy,
    maxFileSizeToReadBytes: 3,
  });
  await expect(store.readTransactionBytes("large.txt")).rejects.toThrow(
    "字节长度",
  );
  expect((await stat(path)).size).toBe(64 * 1024 * 1024);
});
