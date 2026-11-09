import type { ImageReference } from './generation';
import type { Lang } from './types';

export const threeViewSizes = ['1536x864', '1536x1024'] as const;
export const defaultThreeViewSize = threeViewSizes[0];
export const cropViews = ['front', 'side', 'back'] as const;
export type CropView = (typeof cropViews)[number];
export type SideView = 'left' | 'right';
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ThreeViewCrops = Record<CropView, CropRect>;

export function isThreeViewSize(size: string): boolean {
  return threeViewSizes.some((allowed) => allowed === size);
}

export function resolveThreeViewSize(size: string): string {
  return isThreeViewSize(size) ? size : defaultThreeViewSize;
}

export function defaultThreeViewCrops(): ThreeViewCrops {
  return {
    front: { x: 0, y: 0, width: 1 / 3, height: 1 },
    side: { x: 1 / 3, y: 0, width: 1 / 3, height: 1 },
    back: { x: 2 / 3, y: 0, width: 1 / 3, height: 1 },
  };
}

export function cropPixels(crop: CropRect, width: number, height: number) {
  const left = Math.round(crop.x * width);
  const top = Math.round(crop.y * height);
  const right = Math.min(width, Math.round((crop.x + crop.width) * width));
  const bottom = Math.min(height, Math.round((crop.y + crop.height) * height));
  return { left, top, width: right - left, height: bottom - top };
}

export function validateThreeViewCrops(
  crops: ThreeViewCrops,
  width: number,
  height: number,
  minimum = 256,
): 'invalidCrop' | 'cropTooSmall' | 'cropOverlap' | null {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    return 'invalidCrop';
  for (const view of cropViews) {
    const crop = crops[view];
    if (
      !crop ||
      ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.width <= 0 ||
      crop.height <= 0 ||
      crop.x + crop.width > 1 + 1e-9 ||
      crop.y + crop.height > 1 + 1e-9
    )
      return 'invalidCrop';
    const pixels = cropPixels(crop, width, height);
    const scale = Math.min(1, 2048 / Math.max(pixels.width, pixels.height));
    if (Math.round(pixels.width * scale) < minimum || Math.round(pixels.height * scale) < minimum)
      return 'cropTooSmall';
  }
  for (let index = 0; index < cropViews.length; index++) {
    for (let other = index + 1; other < cropViews.length; other++) {
      const first = crops[cropViews[index]],
        second = crops[cropViews[other]];
      if (
        Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x) >
          1e-9 &&
        Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y) >
          1e-9
      )
        return 'cropOverlap';
    }
  }
  return null;
}

export function threeViewPrompt(references: ImageReference[], lang: Lang): string {
  const roles =
    lang === 'zh'
      ? {
          character:
            '保留人物身份、五官、发型发色、肤色与体型，不复制原图的动作、裁切或画风；动漫或插画人物须转为身份可辨识的超写实人物。',
          costume:
            '保留整套服饰、鞋履、配饰的款式、颜色、版型与材质，以真实材质呈现，不继承插画画风或迁移服装模特的身份。',
          pose: '不沿用此图的动作、单一观察角度或裁切；三视图统一采用下述直立参考姿势。',
        }
      : {
          character:
            'Preserve identity, facial features, hair, skin tone and build, not the source pose, crop or art style; translate anime or illustrated characters into recognizable hyperrealistic people.',
          costume:
            'Preserve the complete outfit, footwear, accessories, colors, cuts and materials with realistic material appearance, not the illustration style or clothing model identity.',
          pose: 'Do not copy this pose, single viewpoint or crop; use the neutral reference stance specified below.',
        };
  const details = references
    .map(
      (reference, index) =>
        `${lang === 'zh' ? '参考图' : 'Reference'} ${index + 1} (${reference.kind}): ${roles[reference.kind]}`,
    )
    .join('\n');
  return lang === 'zh'
    ? `生成一张横向三视图拼图，展示同一个人物，供后续 AI 三维重建参考。风格固定为超写实、摄影级真实感：自然皮肤微纹理、真实发丝、织物纤维与缝线、皮革纹理及合理金属反射；不要过度磨皮、过度锐化或塑料质感。不得输出动漫、卡通、插画、绘画或风格化游戏渲染。采用统一柔和漫射棚光，避免戏剧性强阴影；全身清晰，不使用浅景深虚化或运动模糊。横向并排三个互不重叠的等宽区域，从左到右严格为正面、人物自身左侧的纯侧面、背面。三个区域展示同一个人物、同一套服饰和鞋履、同一个姿势；五官、发型、身材、衣服纹样与配饰必须一致。采用近似正交视角，不使用透视夸张或三分之四视角。统一直立，双脚自然分开，双臂略离身体，双手可见；不要沿用复杂动作。三个视角人物等高、头顶与脚底对齐，光照一致，背景纯浅色。每个区域均完整展示头部到鞋底、裤腿或下摆及所有配饰，四周留边距，不能在边缘裁断。不要文字、角度标签、水印、分隔线、额外人物或局部插图。背面不可见的细节合理补全，不宣称精确三维还原。\n${details}`
    : `Create one landscape three-view character reference sheet for AI 3D reconstruction. Use a fixed hyperrealistic, photographic-quality style: natural skin microtexture, realistic hair strands, fabric fibers and stitching, leather grain and plausible metal reflections; no excessive skin smoothing, oversharpening or plastic-looking materials. No anime, cartoon, illustration, painting or stylized game-render aesthetics. Use consistent soft, diffuse studio lighting without dramatic shadows. Keep the full body in focus, with no shallow depth-of-field blur or motion blur. Use three equal, non-overlapping horizontal panels ordered strictly FRONT, the character's own LEFT PROFILE, and BACK. Depict the same person, complete outfit, footwear, accessories and neutral stance in all views, with consistent facial features, hair, build, patterns and lighting. Use approximately orthographic views, not exaggerated perspective or three-quarter angles. Stand upright with feet naturally apart, arms slightly away from the torso and hands visible; do not copy complex poses. Align head tops and soles at the same height. Use a plain light background. Show the complete head-to-sole figure, hems, shoes and accessories with margins in every panel. No cropped extremities, text, labels, watermarks, divider lines, extra people or inset details. Infer unseen back details plausibly without claiming exact 3D reconstruction.\n${details}`;
}

export function enforceThreeViewStyle(prompt: string, lang: Lang): string {
  if (!prompt.trim()) return prompt;
  const requirement =
    lang === 'zh'
      ? '三视图最终风格固定为超写实摄影级效果，使用真实皮肤、发丝与服饰材质。此要求优先于参考图原画风，以及补充或自定义提示词中冲突的风格描述；不得输出动漫、卡通、插画或风格化游戏渲染。'
      : 'The final three-view output must use a hyperrealistic, photographic-quality style with realistic skin, hair and clothing materials. This requirement overrides conflicting reference art styles or supplemental/custom style instructions; no anime, cartoon, illustration or stylized game-render aesthetics.';
  const trimmed = prompt.trimEnd();
  return trimmed.endsWith(requirement) ? trimmed : trimmed + '\n\n' + requirement;
}
