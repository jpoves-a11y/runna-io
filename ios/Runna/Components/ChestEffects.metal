// Light effects for the treasure chests (used by ChestView.swift through SwiftUI's ShaderLibrary).
// All lengths are in points; `scale` is the chest frame's side, so the effect looks the same at
// any size. A Python mirror of this file was used to tune it frame by frame.

#include <metal_stdlib>
#include <SwiftUI/SwiftUI_Metal.h>
using namespace metal;

namespace chest {

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    float d = dot(p, p + 45.32);
    p += d;
    return fract(p.x * p.y);
}

static float valueNoise(float2 p) {
    float2 i = floor(p);
    float2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + float2(1.0, 0.0));
    float c = hash21(i + float2(0.0, 1.0));
    float d = hash21(i + float2(1.0, 1.0));
    float2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/// Fractal noise, 5 octaves, roughly 0…1.
static float fbm(float2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
        value += amplitude * valueNoise(p);
        p = p * 2.03 + float2(17.1, 9.2);
        amplitude *= 0.5;
    }
    return value;
}

} // namespace chest

/// Soft diamond-blue flames rising from the chest outline.
/// `layer`: the chest silhouette (white, slightly blurred) with transparent room around it.
/// Each pixel looks down the layer to know how far above the outline it is ("heat"); rising
/// vertical streaks of noise cut that into separate tongues, and the higher a pixel is the more
/// noise it needs, so every tongue tapers to a point.
[[ stitchable ]] half4 chestFire(float2 position, SwiftUI::Layer layer, float time, float scale, float intensity) {
    float2 q = position / scale;
    // Slow sideways drift of the whole fire
    float warp = chest::fbm(float2(q.x * 2.2, q.y * 1.6 + time * 0.9));

    float rise = 0.36 * scale;
    float heat = 0.0;
    const int steps = 12;
    for (int i = 1; i <= steps; i++) {
        float k = float(i) / float(steps);
        float sway = (warp - 0.5) * 0.30 * scale * k;
        float a = float(layer.sample(position + float2(sway, k * rise)).a);
        heat = max(heat, a * (1.0 - k));
    }
    if (heat <= 0.0) {
        return half4(0.0h);
    }
    float h = 1.0 - heat;

    float streak = chest::fbm(float2(q.x * 7.0 + warp * 1.4, q.y * 1.6 + time * 2.2));
    float detail = chest::fbm(float2(q.x * 13.0 + warp, q.y * 5.0 + time * 3.6));
    float body = streak * 0.85 + detail * 0.25;

    float v = smoothstep(0.0, 0.3, body - 0.12 - h * 0.55);
    v *= pow(heat, 0.5);
    v = clamp(v * intensity, 0.0, 1.0);

    // Deep sapphire → electric blue → ice → almost white at the hottest points
    float3 c1 = float3(0.05, 0.16, 0.62);
    float3 c2 = float3(0.16, 0.50, 1.00);
    float3 c3 = float3(0.55, 0.88, 1.00);
    float3 c4 = float3(0.90, 0.98, 1.00);
    float3 color = mix(c1, c2, smoothstep(0.0, 0.35, v));
    color = mix(color, c3, smoothstep(0.35, 0.75, v));
    color = mix(color, c4, smoothstep(0.85, 1.0, v));
    float alpha = smoothstep(0.0, 0.55, v) * 0.82;
    return half4(half3(color * alpha), half(alpha));
}

/// Glow that follows the chest outline, made of slow wisps (rising, or swirling around the
/// chest when `swirl` > 0). `layer`: the chest silhouette, heavily blurred. `side`: the layer's side.
[[ stitchable ]] half4 chestAura(float2 position, SwiftUI::Layer layer, float time, float scale, float side, half4 tint, float swirl, float strength) {
    float glow = min(float(layer.sample(position).a) * 1.6, 1.0);
    if (glow <= 0.0) {
        return half4(0.0h);
    }
    float2 d = (position - side * 0.5) / scale;
    float angle = atan2(d.y, d.x);
    float u = angle * 1.5 + time * swirl * 0.6;
    float w = chest::fbm(float2(cos(u) * 1.6 + d.x * 2.0, sin(u) * 1.6 + d.y * 2.6 + time * 0.9));
    float wisps = chest::fbm(float2(d.x * 4.0 + w * 2.2, d.y * 3.2 + time * 1.4 - w));
    float breath = 0.82 + 0.18 * sin(time * 6.2831853 / 2.6);
    float intensity = glow * (0.15 + 1.9 * wisps * wisps) * strength * breath;
    float alpha = clamp(intensity, 0.0, 0.9);
    // A little lighter in the brightest wisps
    float hot = smoothstep(0.55, 0.9, alpha);
    float3 color = mix(float3(tint.rgb), float3(1.0), hot * 0.45);
    return half4(half3(color * alpha), half(alpha));
}

/// On the chest itself: a glint of light that sweeps across now and then (stronger on the bright,
/// metallic parts) and, with `glow` > 0, the flickering light of the flames on the top of the chest.
[[ stitchable ]] half4 chestSurface(float2 position, half4 color, float time, float scale, float period, float glint, half4 tint, float glow, half4 light) {
    if (color.a < 0.004h) {
        return color;
    }
    float alpha = float(color.a);
    float3 rgb = float3(color.rgb) / alpha;
    float2 q = position / scale;
    float lum = dot(rgb, float3(0.299, 0.587, 0.114));

    float phase = fract(time / period);
    if (phase < 0.45) {
        float center = mix(-0.5, 1.8, phase / 0.45);
        float diag = q.x + q.y * 0.6;
        float b1 = (diag - center) / 0.07;
        float b2 = (diag - center + 0.14) / 0.03;
        float band = exp(-b1 * b1) + 0.45 * exp(-b2 * b2);
        float spec = band * (0.25 + pow(lum, 1.4)) * glint;
        rgb += spec * (0.85 + 0.15 * float3(tint.rgb));
    }
    if (glow > 0.0) {
        float flicker = glow * (0.78 + 0.22 * sin(time * 9.1) * sin(time * 5.3 + 1.0));
        float top = 1.0 - smoothstep(0.18, 0.62, q.y);
        rgb += float3(light.rgb) * flicker * top * 0.45 * (0.3 + lum);
    }
    rgb = min(rgb, float3(1.0));
    return half4(half3(rgb * alpha), color.a);
}
