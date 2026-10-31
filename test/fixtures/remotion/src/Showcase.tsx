import { AbsoluteFill, Audio, interpolate, OffthreadVideo, Sequence, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";

// 20 seconds of motion graphics: moving gradients, 40 shadowed cards, a per-letter title, two
// picture-in-picture video segments and a looping audio bed. A steady-state benchmark.
const HUES = [210, 260, 320, 20, 160];
const TITLE = "Code the motion. Speed the render.";

const Card = ({ index }: { index: number }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const enter = spring({ frame: frame - index * 4, fps, config: { damping: 18 } });
  const t = frame / fps;
  const column = index % 8;
  const row = Math.floor(index / 8);
  const x = 120 + column * 220 + Math.sin(t * 0.9 + index) * 30;
  const y = 260 + row * 150 + Math.cos(t * 1.1 + index * 0.7) * 24;
  const hue = HUES[index % HUES.length]!;
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: 180,
        height: 110,
        borderRadius: 16,
        transform: `translate(${x}px, ${y + (1 - enter) * height * 0.2}px) rotate(${Math.sin(t + index) * 6}deg)`,
        opacity: enter,
        background: `linear-gradient(135deg, hsl(${hue} 80% 60%), hsl(${hue + 40} 70% 40%))`,
        boxShadow: "0 12px 30px rgba(0,0,0,.45)",
        color: "white",
        fontFamily: "Helvetica, Arial, sans-serif",
        fontWeight: 700,
        fontSize: 20,
        padding: 12,
        boxSizing: "border-box",
        maxWidth: width,
      }}
    >
      #{String(index + 1).padStart(2, "0")} · {(t * 10 + index).toFixed(1)}
    </div>
  );
};

export const Showcase = () => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames, width } = useVideoConfig();
  const t = frame / fps;
  return (
    <AbsoluteFill style={{ background: "#0b0d12", overflow: "hidden" }}>
      <Audio src={staticFile("tone.wav")} loop volume={(f) => interpolate(f, [0, 30, durationInFrames - 30, durationInFrames], [0, 0.6, 0.6, 0])} />
      {HUES.slice(0, 3).map((hue, i) => (
        <div
          key={hue}
          style={{
            position: "absolute",
            width: 620,
            height: 620,
            borderRadius: "50%",
            opacity: 0.5,
            background: `radial-gradient(circle, hsl(${hue} 90% 60%), transparent 70%)`,
            transform: `translate(${400 + i * 500 + Math.sin(t * 0.5 + i) * 200}px, ${200 + Math.cos(t * 0.4 + i * 2) * 160}px)`,
          }}
        />
      ))}
      {Array.from({ length: 40 }, (_, i) => (
        <Card key={i} index={i} />
      ))}
      <div style={{ position: "absolute", left: 0, right: 0, top: 70, textAlign: "center", fontFamily: "Helvetica, Arial, sans-serif", fontSize: 76, fontWeight: 800, color: "white" }}>
        {TITLE.split("").map((ch, i) => {
          const k = spring({ frame: frame - 10 - i * 2, fps, config: { damping: 12 } });
          return (
            <span key={i} style={{ display: "inline-block", transform: `translateY(${(1 - k) * 60}px)`, opacity: k, whiteSpace: "pre" }}>
              {ch}
            </span>
          );
        })}
      </div>
      {[150, 420].map((from) => (
        <Sequence key={from} from={from} durationInFrames={90}>
          <div style={{ position: "absolute", right: 80, bottom: 80, width: 480, height: 270, borderRadius: 20, overflow: "hidden", boxShadow: "0 24px 60px rgba(0,0,0,.6)" }}>
            <OffthreadVideo src={staticFile("clip.mp4")} muted style={{ width: "100%", height: "100%" }} />
          </div>
        </Sequence>
      ))}
      <div style={{ position: "absolute", left: 160, bottom: 60, height: 12, borderRadius: 6, width: ((width - 320) * frame) / (durationInFrames - 1), background: "linear-gradient(90deg, #6cf, #c6f)" }} />
    </AbsoluteFill>
  );
};
