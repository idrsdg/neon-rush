/* Neon Rush: hand-keyed animation tables (ours). Loaded by race/index.html before the game script; edit here, no build step.
   A track is a list of keys: [time in seconds, [values...], easing to the next key].
   Easings: lin, hold, in2, out2, out3, io (sine in-out), io3 (cubic in-out), back (overshoot), expo.
   1150 below is the chase camera height (CAM_HC in the game). */
window.NEON_RUSH_KEYS = {
 tracks: {
  // start: the camera sweeps from low beside the front wheel up to the chase position while the five reds light. [cam x offset, cam height, dolly (- = closer), roll]
  cine: [[0,[400,380,-270,-0.03],'io'],[1.4,[240,500,-190,-0.018],'io'],[2.35,[90,820,-80,-0.006],'out3'],[2.9,[0,1150,0,0],'hold']],
  // one start light switching on: [scale, glow]
  lamp: [[0,[0.7,0],'out3'],[0.05,[1.12,1.35],'io'],[0.18,[1,1],'hold']],
  // gantry drops in, and lifts away after lights out: [y (gantry heights, 0 = in place), alpha]
  gantryIn: [[0,[-1.4,0],'out3'],[0.42,[0.08,1],'io'],[0.6,[0,1],'hold']],
  gantryOut: [[0,[0,1],'hold'],[0.5,[0,1],'in2'],[0.85,[-1.4,0],'hold']],
  // GO under the gantry: [scale, alpha]
  go: [[0,[0.7,0],'back'],[0.12,[1.06,1],'io'],[0.24,[1,1],'hold'],[0.6,[1,1],'in2'],[0.85,[1.04,0],'hold']],
  // launch: [rear squat (car heights), nose lift, rear wheel smoke rate, camera kick]
  launch: [[0,[0,0,0,0],'out3'],[0.07,[0.045,0.05,1,0.8],'io'],[0.32,[0.03,0.04,1,0.45],'io'],[0.7,[0.008,0.008,0.25,0.1],'io'],[1.05,[0,0,0,0],'hold']],
  // nitro ignition: [flame length, flame width, white core, camera kick, shock ring]; after 0.4 s the flame loops on NITRO_FLICK
  nitro: [[0,[0.15,1.5,1,0,0],'out3'],[0.05,[1.75,0.62,1,1,1],'io'],[0.12,[0.82,1.08,0.65,0.7,0.55],'io'],[0.22,[1.25,0.9,0.4,0.42,0.2],'io'],[0.4,[1,1,0.25,0.15,0],'hold']],
  // lap board: [x (1 = off to the right), alpha, row 1, row 2, row 3, underline]
  lap: [[0,[1,0,0,0,0,0],'out3'],[0.32,[0,1,0,0,0,0],'out2'],[0.46,[0,1,1,0,0,0.6],'out2'],[0.58,[0,1,1,1,0,1],'out2'],[0.7,[0,1,1,1,1,1],'hold'],[3.1,[0,1,1,1,1,1],'in2'],[3.45,[1.1,0,1,1,1,1],'hold']],
  // position gained: [badge scale, alpha, chevron rise, flash]
  gain: [[0,[0.4,0,1,1],'back'],[0.16,[1.18,1,0,0.9],'io'],[0.28,[0.95,1,-0.25,0.35],'io'],[0.4,[1,1,0,0],'hold'],[1.5,[1,1,0,0],'in2'],[1.8,[0.92,0,0,0],'hold']],
  // finish: [cam x offset, cam height, dolly, roll, time scale]
  fin: [[0,[0,1150,0,0,0.3],'io'],[0.55,[-240,620,-190,0.028,0.3],'io'],[1.7,[-400,430,-290,0.042,0.42],'io'],[2.6,[-110,820,-70,0.01,1],'io3'],[3.2,[0,1150,0,0,1],'hold']],
  // finish title: [scale, alpha, rule width]
  finTitle: [[0,[0.82,0,0],'back'],[0.2,[1.04,1,0.4],'io'],[0.34,[1,1,1],'hold'],[2.4,[1,1,1],'in2'],[2.9,[1.02,0,1],'hold']],
  // moment lines (popups): [alpha, y offset, scale]
  pop: [[0,[0,10,0.94],'out3'],[0.16,[1,0,1],'hold'],[1.25,[1,0,1],'in2'],[1.6,[0,-12,1],'hold']],
  // one confetti piece: [scale, alpha]
  conf: [[0,[0,1],'back'],[0.1,[1.25,1],'io'],[0.2,[1,1],'hold'],[2.2,[1,1],'in2'],[2.8,[0.8,0],'hold']],
 },
 // neon signs: one hand-keyed level sequence per sign (1 = lit), stepped at 20 fps; most hum steadily, a few stutter or die and relight
 NEON_FLICKER:[
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0.85,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0.3,0.3,1,1,1,1,1,1,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,0,0,0,0,0,0,0.4,0,1,0.6,1,1],
  [1,0.92,1,0.95,1,1,0.9,1,1,0.94,1,1,1,0.9,1,1],
  [1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0,0,1,1,1,1,1,1,1,1,1,1,1,1],
 ],
 // dust devil puffs: [phase, radius scale, extra spin]
 DUST_DEVIL:[[0,1,0.4],[0.33,0.7,0.6],[0.66,0.45,0.85],[0.15,0.85,0.3]],
 // grandstand crowd: arms-up pose on these beats (6 beats/s, offset per stand)
 BIRD_FLAP:[0,0,1,2,2,1],   /* wing pose per step at 9 fps: up, up, level, down, down, level */
 CROWD_BEAT:[0,1,1,0,0,1,0,1,1,1,0,0],
 NITRO_FLICK:[1,0.86,1.1,0.93,1.05,0.9,1.08,0.95],   /* hand-keyed flame loop, stepped at 24 fps */
 LIGHT_T:[0.55,1.05,1.55,2.05,2.55],   /* start lights: one red every 0.5 s, then a short random hold before lights out */
 // confetti: two cannons at the bottom corners fire on keyed beats; piece: [delay, angle deg from vertical, speed (screen heights/s), spin rad/s, shape, colour, flutter phase]
 // shapes: 0 ribbon, 1 diamond, 2 chevron, 3 four-point star. The right cannon mirrors the left one.
 CONF_L:[[0.00,8,1.55,7,0,0,0],[0.00,14,1.42,-9,1,1,1.1],[0.00,20,1.62,11,2,2,2.3],[0.03,26,1.35,-6,3,3,0.7],[0.03,11,1.75,8,0,4,1.9],[0.05,31,1.25,-12,1,0,2.8],
  [0.05,17,1.5,10,2,1,0.4],[0.08,23,1.66,-7,0,2,1.5],[0.08,36,1.18,9,3,4,2.1],[0.1,5,1.82,-10,1,3,0.2],[0.12,28,1.4,6,0,1,3.0],[0.12,12,1.58,-8,2,0,1.2]],
 CONF_BEATS:[[0.12,0,1],[0.3,1,1],[0.62,0,0.8],[0.62,1,0.8]],   /* [beat s, cannon (0 left, 1 right), speed scale]; the last two only on the podium */
 // impact debris (rear hit / side scrape): [kind (0 bumper shard, 1 hubcap, 2 glass glint), vx, vy (struck-car widths/s), spin rad/s, size (car widths)]
 IMPACT_DEBRIS:[[0,-0.75,-1.25,-11,0.09],[0,0.85,-1.05,13,0.07],[1,1.3,-0.8,16,0.075],[2,-0.35,-1.5,8,0.035],[2,0.4,-1.65,-9,0.03],[2,0.1,-1.85,6,0.028]],
 IMPACT_DEBRIS_SIDE:[[0,0.55,-0.7,10,0.06],[2,0.8,-1.0,-8,0.03],[2,0.35,-1.2,7,0.026]],
};
