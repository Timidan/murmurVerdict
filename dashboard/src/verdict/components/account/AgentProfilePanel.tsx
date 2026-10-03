// The agent's public name and description, plus the one field that cannot
// change.
//
// The handle is shown here, greyed and uneditable, with the reason next to it.
// Hiding it would leave an owner hunting for a rename control that does not
// exist; showing it without the reason reads as an oversight. It is neither —
// the handle is in every URL and on every receipt a subscriber holds.

import { useCallback, useEffect, useState } from "react";
import { getAccessToken } from "@privy-io/react-auth";

import { verdictApi, type AccountAgent } from "../../api.js";
import { Ik } from "../../icons.js";
import { InlineError } from "../compact/InlineError.js";

const INPUT_CLASS =
  "ck-mono bg-transparent border border-[var(--color-border-vis)] px-2 py-1 outline-none focus:border-[var(--color-display)] disabled:opacity-50 disabled:cursor-not-allowed";

export function AgentProfilePanel({
  slug,
  agent,
  onSaved,
}: {
  slug: string;
  agent: AccountAgent | null;
  onSaved?: () => void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [bio, setBio] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  // Seed from the account-wide agent list. It is already loaded by the time
  // this panel mounts, so there is no second round-trip just to fill a form.
  useEffect(() => {
    setDisplayName(agent?.display_name ?? "");
    setBio(agent?.bio ?? "");
  }, [agent?.display_name, agent?.bio]);

  const save = useCallback(async () => {
    setError(null);
    setSaved(null);
    const name = displayName.trim();
    if (!name) {
      setError("Enter a name. It is what people see on the leaderboard.");
      return;
    }
    setBusy(true);
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("Your session expired. Sign in again.");
      const trimmedBio = bio.trim();
      const result = await verdictApi.patchAgentProfile(token, slug, {
        display_name: name,
        // An empty box means "clear it", and the wire says that with null.
        bio: trimmedBio === "" ? null : trimmedBio,
      });
      setDisplayName(result.agent.display_name);
      setBio(result.agent.bio ?? "");
      setSaved("Saved.");
      onSaved?.();
    } catch (e) {
      setError((e as Error)?.message ?? "unknown error");
    } finally {
      setBusy(false);
    }
  }, [displayName, bio, slug, onSaved]);

  return (
    <section className="ck-frame w-full flex flex-col">
      <div className="ck-header">
        <span className="ck-title ck-title-ik">
          <Ik name="agent" /> Profile
        </span>
      </div>

      <div className="px-4 py-4 flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">Handle</span>
          <span className="flex items-center gap-2">
            <span
              className="ck-mono ck-dim border border-[var(--color-border)] px-2 py-1"
              title="The handle cannot change."
            >
              {slug}
            </span>
            <span aria-hidden="true" className="ck-dim">
              <Ik name="revoke" />
            </span>
          </span>
          <span className="ck-dim text-[12px]">
            You cannot change the handle.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">Name</span>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.currentTarget.value)}
            disabled={busy}
            maxLength={120}
            className={`${INPUT_CLASS} self-start w-[32ch] max-w-full min-w-0`}
          />
          <span className="ck-dim text-[12px]">
            What people see on the leaderboard and on your public page.
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ck-label ck-pos">Bio</span>
          <textarea
            value={bio}
            onChange={(e) => setBio(e.currentTarget.value)}
            disabled={busy}
            maxLength={500}
            rows={3}
            className={INPUT_CLASS}
          />
          <span className="ck-dim text-[12px]">
            One or two lines about what this agent trades. Leave it empty to
            remove it.
          </span>
        </label>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy}
            className="ck-btn ck-btn-bracket ck-pos justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            save the profile
          </button>
        </div>

        {saved && <span className="ck-pos text-[12px]">{saved}</span>}
        {error && <InlineError error={error} className="text-[12px]" />}
      </div>
    </section>
  );
}
