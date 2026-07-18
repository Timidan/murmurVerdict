import { Composition, registerRoot } from "remotion";
import { LogoSting } from "./LogoSting";

// 1920x1080, 30fps, 150 frames (5s), one-shot. Dark palette lives in LogoSting.
export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="LogoSting"
      component={LogoSting}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
    />
  );
};

registerRoot(RemotionRoot);
