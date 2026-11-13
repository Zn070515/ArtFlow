import { Canvas } from "@react-three/fiber";

import { useDocumentVisibility } from "../../hooks/useDocumentVisibility.js";

import { ChromeRing } from "./ChromeRing.js";
import { DustField } from "./DustField.js";
import { themeColor } from "./palette.js";
import { ShaderPlane } from "./ShaderPlane.js";

export default function AuroraCanvas() {
  const hidden = useDocumentVisibility();
  return (
    <Canvas
      dpr={[1, 2]}
      frameloop={hidden ? "never" : "always"}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 5], fov: 45 }}
      onCreated={({ gl }) => gl.setClearColor(themeColor("--ink", "#07070A"), 1)}
    >
      <ShaderPlane />
      <DustField />
      <ChromeRing />
    </Canvas>
  );
}
