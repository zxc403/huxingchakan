import { createBuildingScene } from './scene.js'

export function createProject() {
  return {
    id: 'building-51',
    name: '3栋51# 建筑漫游',
    defaultSceneId: 'tour',
    scenes: [
      { id: 'tour', name: '建筑巡场', createScene: (options) => createBuildingScene({ ...options, mode: 'tour' }) },
      { id: 'walk', name: '自由漫游', createScene: (options) => createBuildingScene({ ...options, mode: 'walk' }) },
    ],
  }
}
