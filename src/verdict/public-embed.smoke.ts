import { strict as assert } from "node:assert";
import vm from "node:vm";

import { publicEmbedScript } from "./public-embed.js";

type EmbedEvent = { data?: string };
type EmbedListener = (event: EmbedEvent) => void;

class FakeElement {
  alt = "";
  children: FakeElement[] = [];
  height = 0;
  href = "";
  loading = "";
  parentNode: FakeParent | null = null;
  rel = "";
  src = "";
  style: Record<string, string> = {};
  target = "";
  width = 0;

  constructor(
    readonly tagName: string,
    private readonly attrs: Record<string, string> = {},
  ) {}

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  appendChild(child: FakeElement): void {
    this.children.push(child);
  }
}

class FakeParent {
  inserted: { node: FakeElement; before: FakeElement } | null = null;

  insertBefore(node: FakeElement, before: FakeElement): void {
    this.inserted = { node, before };
  }
}

process.stdout.write("murmur public embed smoke\n");

const escaped = publicEmbedScript({
  publicUrl: `https://api.murmur.example/"quoted"`,
});
assert.equal(escaped.includes("__PUBLIC_URL__"), false);
assert.equal(
  escaped.includes(`var BASE = "https://api.murmur.example/\\"quoted\\"";`),
  true,
);

const badge = runEmbed({ "data-slug": "agent one" });
const badgeAnchor = badge.parent.inserted?.node;
assert.ok(badgeAnchor);
const badgeImg = badgeAnchor.children[0];
assert.ok(badgeImg);
assert.equal(badgeAnchor.tagName, "a");
assert.equal(badgeAnchor.href, "https://api.murmur.example/share/agent%20one");
assert.equal(badgeAnchor.target, "_blank");
assert.equal(badgeAnchor.rel, "noopener noreferrer");
assert.equal(
  badgeImg.src,
  "https://api.murmur.example/v1/badge/agent%20one.svg?v=0",
);
assert.equal(badgeImg.alt, "agent one on Murmur Verdict");
assert.equal(badgeImg.loading, "lazy");
assert.equal(badgeImg.width, 320);
assert.equal(badgeImg.height, 80);
assert.equal(badge.eventSources[0]?.url, "https://api.murmur.example/v1/stream");

badge.eventSources[0]?.emit("leaderboard.update");
assert.equal(
  badgeImg.src,
  "https://api.murmur.example/v1/badge/agent%20one.svg?v=1",
);

badge.eventSources[0]?.emit("call.resolved", {
  data: JSON.stringify({ agent_slug: "someone else" }),
});
assert.equal(
  badgeImg.src,
  "https://api.murmur.example/v1/badge/agent%20one.svg?v=1",
);
badge.eventSources[0]?.emit("call.resolved", {
  data: JSON.stringify({ agent_slug: "agent one" }),
});
assert.equal(
  badgeImg.src,
  "https://api.murmur.example/v1/badge/agent%20one.svg?v=2",
);
badge.eventSources[0]?.onerror?.();
assert.equal(badge.eventSources[0]?.closed, true);
assert.deepEqual(badge.reconnectDelays, [1000]);

const og = runEmbed({
  "data-href": "https://dashboard.murmur.example/custom",
  "data-no-live": "true",
  "data-slug": "og-agent",
  "data-variant": "og",
  "data-version": "41",
});
const ogAnchor = og.parent.inserted?.node;
assert.ok(ogAnchor);
const ogImg = ogAnchor.children[0];
assert.ok(ogImg);
assert.equal(ogAnchor.href, "https://dashboard.murmur.example/custom");
assert.equal(
  ogImg.src,
  "https://api.murmur.example/v1/og/og-agent.svg?v=41",
);
assert.equal(ogImg.width, 1200);
assert.equal(ogImg.height, 630);
assert.equal(og.eventSources.length, 0);

const missingSlug = runEmbed({});
assert.equal(missingSlug.parent.inserted, null);
assert.deepEqual(missingSlug.warnings, [
  "[murmur-embed] missing data-slug on the <script> tag",
]);
assert.equal(missingSlug.eventSources.length, 0);

process.stdout.write("public embed smoke ok\n");

function runEmbed(
  attrs: Record<string, string>,
  options: { publicUrl?: string; liveAvailable?: boolean } = {},
) {
  const script = new FakeElement("script", attrs);
  const parent = new FakeParent();
  script.parentNode = parent;
  const createdElements: FakeElement[] = [];
  const eventSources: Array<{
    closed: boolean;
    emit: (name: string, event?: EmbedEvent) => void;
    onerror: (() => void) | null;
    url: string;
  }> = [];
  const reconnectDelays: number[] = [];
  const warnings: string[] = [];
  const fakeDocument = {
    currentScript: script,
    createElement(tagName: string): FakeElement {
      const element = new FakeElement(tagName);
      createdElements.push(element);
      return element;
    },
  };

  class FakeEventSource {
    closed = false;
    listeners = new Map<string, EmbedListener[]>();
    onerror: (() => void) | null = null;

    constructor(readonly url: string) {
      eventSources.push(this);
    }

    addEventListener(name: string, listener: EmbedListener): void {
      this.listeners.set(name, [
        ...(this.listeners.get(name) ?? []),
        listener,
      ]);
    }

    close(): void {
      this.closed = true;
    }

    emit(name: string, event: EmbedEvent = {}): void {
      for (const listener of this.listeners.get(name) ?? []) {
        listener(event);
      }
    }
  }

  const context = vm.createContext({
    EventSource: options.liveAvailable === false ? undefined : FakeEventSource,
    JSON,
    Math,
    console: {
      warn: (message: string) => {
        warnings.push(message);
      },
    },
    document: fakeDocument,
    encodeURIComponent,
    setTimeout: (_callback: () => void, delay: number) => {
      reconnectDelays.push(delay);
      return 0;
    },
  });

  vm.runInContext(
    publicEmbedScript({
      publicUrl: options.publicUrl ?? "https://api.murmur.example",
    }),
    context,
  );

  return {
    createdElements,
    eventSources,
    parent,
    reconnectDelays,
    warnings,
  };
}
