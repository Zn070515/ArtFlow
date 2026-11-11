import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

import { themeColor } from "./palette.js";
import { shouldRenderChromeRing } from "./ringVisibility.js";
import { ringFragment, ringVertex } from "./shaders.js";

export function ChromeRing() {
  const mesh = useRef<THREE.Mesh>(null);
  const viewport = useThree((state) => state.viewport);
  const viewportWidth = useThree((state) => state.size.width);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uGold: { value: themeColor("--gold", "#E8B45A") },
      uEmber: { value: themeColor("--ember", "#C2410C") },
      uCool: { value: themeColor("--cool", "#7DD3FC") },
    }),
    [],
  );

  const lineMaterial = useRef<THREE.MeshBasicMaterial>(null);

  useEffect(() => {
    uniforms.uGold.value.copy(themeColor("--gold", "#E8B45A"));
    uniforms.uEmber.value.copy(themeColor("--ember", "#C2410C"));
    uniforms.uCool.value.copy(themeColor("--cool", "#7DD3FC"));
    lineMaterial.current?.color.copy(themeColor("--gold", "#E8B45A"));
  }, [uniforms]);

  useFrame((_state, delta) => {
    if (document.visibilityState === "hidden") return;
    uniforms.uTime.value += Math.min(delta, 0.05);
    if (mesh.current !== null) {
      mesh.current.rotation.x += delta * 0.12;
      mesh.current.rotation.y += delta * 0.18;
    }
  });

  if (!shouldRenderChromeRing(viewportWidth)) return null;

  const x = Math.min(1.7, viewport.width * 0.28);
  const scale = viewport.width < 4 ? 0.62 : 0.95;

  return (
    <group position={[x, 0.18, -1.2]} rotation={[0.45, 0.2, 0]} scale={scale}>
      <mesh ref={mesh}>
        <torusGeometry args={[0.9, 0.26, 64, 128]} />
        <shaderMaterial
          uniforms={uniforms}
          vertexShader={ringVertex}
          fragmentShader={ringFragment}
          transparent
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
      <mesh rotation={[1.1, 0.35, 0]}>
        <torusGeometry args={[1.36, 0.008, 16, 128]} />
        <meshBasicMaterial ref={lineMaterial} color="#E8B45A" transparent opacity={0.32} />
      </mesh>
    </group>
  );
}
