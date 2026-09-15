import { TopbarCrumb } from "../components/compact/TopbarCrumb.js";
import { Panel } from "../components/compact/Panel.js";
import { Ik } from "../icons.js";
import { Section } from "./PrivacyPage.js";

const LINK = "ck-mono ck-pos no-underline hover:underline";

/** /credits: third-party work murmur ships, and the licence each comes under. */
export function CreditsPage() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <TopbarCrumb>
        <span className="inline-flex items-center gap-1.5">
          <Ik name="skill-file" /> credits
        </span>
      </TopbarCrumb>

      <h1 className="sr-only">murmur credits</h1>

      <main className="flex-1 min-h-0 overflow-auto">
        <Panel title="credits">
          <div className="px-3 py-3 flex flex-col gap-4 max-w-[72ch] ck-mono leading-relaxed">
            <Section title="icons">
              Some interface icons come from the Sharp Line and Sharp Solid sets by{" "}
              <a href="https://streamlinehq.com" target="_blank" rel="noreferrer" className={LINK}>
                Streamline
              </a>
              , licensed under{" "}
              <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer" className={LINK}>
                CC BY 4.0
              </a>
              . murmur recolors them to follow the theme and sets one stroke weight; no shape
              was changed. Source:{" "}
              <a href="https://github.com/webalys-hq/streamline-vectors" target="_blank" rel="noreferrer" className={LINK}>
                streamline-vectors
              </a>
              .
            </Section>

            <Section title="photograph">
              The landing background is{" "}
              <a href="https://www.rawpixel.com/image/3302653/free-photo-image-asphalt-bridge-building" target="_blank" rel="noreferrer" className={LINK}>
                Red white car light trails
              </a>{" "}
              from rawpixel, dedicated to the public domain under{" "}
              <a href="https://creativecommons.org/publicdomain/zero/1.0/" target="_blank" rel="noreferrer" className={LINK}>
                CC0 1.0
              </a>
              .
            </Section>

            <Section title="typeface">
              Display numerals use Doto, served by Google Fonts under the{" "}
              <a href="https://openfontlicense.org" target="_blank" rel="noreferrer" className={LINK}>
                SIL Open Font License 1.1
              </a>
              .
            </Section>

            <Section title="open-source software">
              This site includes open-source packages. Their licence texts are in{" "}
              <a href="/third-party-licenses.txt" target="_blank" rel="noreferrer" className={LINK}>
                third-party-licenses.txt
              </a>
              .
            </Section>
          </div>
        </Panel>
      </main>
    </div>
  );
}
