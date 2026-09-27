// renderer-min's scene in three.js 0.160, imported from the root module as Aether does.
import {
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from 'three'

const canvas = document.getElementById('c')
const renderer = new WebGLRenderer({ canvas, antialias: true })
renderer.shadowMap.enabled = true
renderer.shadowMap.type = PCFSoftShadowMap
const scene = new Scene()
const camera = new PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 1000)
camera.position.set(0, 12, 16)
camera.lookAt(0, 0, 0)
const sun = new DirectionalLight(0xffffff, 3)
sun.position.set(5, 10, 5)
sun.castShadow = true
scene.add(sun)
const geometry = new BoxGeometry(0.8, 0.8, 0.8)
const material = new MeshStandardMaterial({ color: 0xcc4d33, roughness: 0.5 })
for (let i = 0; i < 100; i++) {
  const box = new Mesh(geometry, material)
  box.position.set((i % 10) - 4.5, 0, Math.floor(i / 10) - 4.5)
  box.castShadow = box.receiveShadow = true
  scene.add(box)
}
const frame = () => {
  renderer.setSize(innerWidth, innerHeight, false)
  renderer.render(scene, camera)
  requestAnimationFrame(frame)
}
frame()
