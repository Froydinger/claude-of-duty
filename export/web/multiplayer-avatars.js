import { attachWeapon } from './enemy-system.js';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// Independent render-only actors: no bot agents, targets, damage or AI state.
export class MultiplayerAvatars {
  constructor(scene, assets) { this.scene = scene; this.assets = assets; this.actors = new Map(); }
  update(client, dt) {
    for (const [id, actor] of this.actors) if (!client.peers.has(id)) {
      this.scene.remove(actor.root);
      actor.mixer.stopAllAction();
      actor.mixer.uncacheRoot(actor.body);
      this.actors.delete(id);
    }
    for (const [id, peer] of client.peers) {
      let actor = this.actors.get(id);
      if (!actor) {
        const body = SkeletonUtils.clone(this.assets.bodyTemplate);
        const root = new THREE.Group();
        body.rotation.y = Math.PI / 2;
        root.add(body);
        attachWeapon(body, this.assets.weaponTemplate.clone(true), this.assets.weaponMounts.idle);
        const mixer = new THREE.AnimationMixer(body);
        actor = { root, body, mixer, actions: Object.fromEntries(['idle', 'run'].map(k => [k, mixer.clipAction(this.assets.clips[k])])) };
        this.scene.add(root);
        this.actors.set(id, actor);
      }
      const s = client.sample(peer);
      actor.root.position.fromArray(s.position);
      actor.root.rotation.y = s.yaw;
      // The shipped animation set has standing/run clips only. Compress the
      // body for crouch; airborne motion follows the transmitted feet height.
      actor.body.scale.y = s.crouch ? 0.65 : 1;
      const key = s.moving ? 'run' : 'idle';
      if (actor.key !== key) {
        actor.actions[actor.key]?.fadeOut(0.12);
        actor.actions[key].reset().fadeIn(0.12).play();
        actor.key = key;
      }
      actor.mixer.update(dt * (s.sprint ? 1.6 : s.crouch ? 0.6 : 1));
      actor.root.userData.weapon = s.weapon;
    }
  }
}
