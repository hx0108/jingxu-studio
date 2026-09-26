import candidate1 from './candidate-1.webp';
import candidate2 from './candidate-2.webp';
import candidate3 from './candidate-3.webp';
import characterRef1 from './character-ref-1.webp';
import characterRef2 from './character-ref-2.webp';
import cinematicTrainBackground from './cinematic-train-background.webp';
import continueDrama from './continue-drama.webp';
import heroineMain from './heroine-main.webp';
import homeComic from './home-comic.webp';
import homeDrama from './home-drama.webp';
import project1 from './project-1.webp';
import project2 from './project-2.webp';
import project3 from './project-3.webp';
import project4 from './project-4.webp';
import project5 from './project-5.webp';
import sceneRef from './scene-ref.webp';
import shot1 from './shot-1.webp';
import shot2 from './shot-2.webp';
import shot3 from './shot-3.webp';
import shot4 from './shot-4.webp';
import shot5 from './shot-5.webp';
import shot6 from './shot-6.webp';

/** 经用户确认的十页原型本地视觉资源。这里只提供展示 URL；业务状态仍以 IPC 返回为准。 */
export const PROTOTYPE_ASSETS = {
  candidates: [candidate1, candidate2, candidate3],
  characterReferences: [characterRef1, characterRef2],
  cinematicTrainBackground,
  continueDrama,
  heroineMain,
  home: { comic: homeComic, drama: homeDrama },
  projects: [project1, project2, project3, project4, project5],
  sceneReference: sceneRef,
  shots: [shot1, shot2, shot3, shot4, shot5, shot6],
} as const;

export const prototypeAssetAt = (assets: readonly string[], index: number): string | undefined =>
  assets[index % assets.length];
