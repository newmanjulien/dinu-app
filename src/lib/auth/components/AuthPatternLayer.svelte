<script lang="ts">
	import { onMount } from 'svelte';

	const spacing = 7.6;
	const interval = 300;
	let canvas: HTMLCanvasElement;
	let ready = $state(false);

	onMount(() => {
		const context = canvas.getContext('2d');
		if (!context) return;

		type Dot = { x: number; y: number; path: Path2D; seed: number; phase: number; step: number };
		let dots: Dot[] = [];
		let width = 0;
		let height = 0;
		let ratio = 0;
		let frame = 0;
		let lastFrame = 0;
		let lastDraw = -interval;
		let nextDot = 0;
		const start = performance.now();
		const dotColor = getComputedStyle(canvas).getPropertyValue('--color-line-strong').trim();
		const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
		let resolution = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);

		function random(seed: number) {
			let value = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b);
			value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
			return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
		}

		function paint(dot: Dot, time: number) {
			if (!context) return;
			dot.step = Math.floor((time + dot.phase) / interval);
			// Each dot holds a random brightness for 300ms, independently of its neighbors.
			context.clearRect(dot.x - 1, dot.y - 1, 4, 4);
			context.globalAlpha = 0.16 + random(dot.seed + Math.imul(dot.step + 1, 0x9e3779b9)) * 0.52;
			context.fill(dot.path);
		}

		function draw(time: number, reset = false) {
			if (!context || !dots.length) return;
			context.fillStyle = dotColor;
			if (reset || time - lastDraw >= interval || time < lastDraw) {
				let earliest = Infinity;
				for (let index = 0; index < dots.length; index++) {
					const dot = dots[index];
					paint(dot, time);
					const nextChange = (dot.step + 1) * interval - dot.phase;
					if (nextChange < earliest) {
						earliest = nextChange;
						nextDot = index;
					}
				}
			} else {
				// Phases are ordered, so stop as soon as the next dot is not due.
				while (dots[nextDot].step !== Math.floor((time + dots[nextDot].phase) / interval)) {
					paint(dots[nextDot], time);
					nextDot = (nextDot + 1) % dots.length;
				}
			}
			lastDraw = time;
		}

		function animate(now: number) {
			if (now - lastFrame >= 1000 / 30) {
				draw(now - start);
				lastFrame = now;
			}
			frame = requestAnimationFrame(animate);
		}

		function syncAnimation() {
			cancelAnimationFrame(frame);
			frame = 0;
			lastFrame = 0;
			if (!width || !height || document.hidden) return;
			draw(reducedMotion.matches ? 0 : performance.now() - start, true);
			if (!reducedMotion.matches) {
				frame = requestAnimationFrame(animate);
			}
		}

		function resize() {
			if (!context) return;
			const bounds = canvas.getBoundingClientRect();
			const nextRatio = Math.min(window.devicePixelRatio || 1, 2);
			if (bounds.width === width && bounds.height === height && nextRatio === ratio) return;
			({ width, height } = bounds);
			ratio = nextRatio;
			canvas.width = Math.round(width * ratio);
			canvas.height = Math.round(height * ratio);
			context.setTransform(ratio, 0, 0, ratio, 0, 0);
			dots = [];
			for (let row = 0; row * spacing < height; row++) {
				const y = row * spacing;
				// The fixed fade is fully transparent across the middle of the quote panel.
				if (y / height > 0.4 && y / height < 0.6) continue;
				for (let column = 0; column * spacing < width; column++) {
					const x = column * spacing;
					const seed = Math.imul(row + 1, 0x1f123bb5) ^ Math.imul(column + 1, 0x5f356495);
					const path = new Path2D();
					path.roundRect(x, y, 2, 2, 0.32);
					dots.push({ x, y, path, seed, phase: random(seed) * interval, step: -1 });
				}
			}
			dots.sort((a, b) => b.phase - a.phase);
			syncAnimation();
			ready = width > 0 && height > 0;
		}

		function syncResolution() {
			resolution.removeEventListener('change', syncResolution);
			resolution = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
			resolution.addEventListener('change', syncResolution);
			resize();
		}

		const observer = new ResizeObserver(resize);
		observer.observe(canvas);
		resolution.addEventListener('change', syncResolution);
		reducedMotion.addEventListener('change', syncAnimation);
		document.addEventListener('visibilitychange', syncAnimation);

		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			resolution.removeEventListener('change', syncResolution);
			reducedMotion.removeEventListener('change', syncAnimation);
			document.removeEventListener('visibilitychange', syncAnimation);
		};
	});
</script>

<div class="dot-field pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
	<svg class="absolute inset-0 size-full" class:invisible={ready} width="100%" height="100%">
		<defs>
			<pattern id="auth-dot-grid" width={spacing} height={spacing} patternUnits="userSpaceOnUse">
				<rect width="2" height="2" rx="0.32" fill="var(--color-line-strong)" opacity="0.42" />
			</pattern>
		</defs>
		<rect width="100%" height="100%" fill="url(#auth-dot-grid)" />
	</svg>
	<canvas bind:this={canvas} class="absolute inset-0 size-full"></canvas>
</div>

<style>
	.dot-field {
		mask-image: linear-gradient(to bottom, black 10%, transparent 40%, transparent 60%, black 90%);
	}
</style>
