import { getContext, setContext } from 'svelte';

export const VIDEO_ORIGIN = 'https://www.youtube-nocookie.com';

export type EmbeddedVideo = {
	id: string;
	title: string;
	poster: string;
};

type FetchPriority = 'low' | 'auto' | 'high';
const priorityRank: Record<FetchPriority, number> = { low: 0, auto: 1, high: 2 };
const warmedPosters = new Map<string, number>();

export function warmVideoPoster(poster: string, fetchPriority: FetchPriority = 'low') {
	try {
		if (typeof Image === 'undefined') return;
		const rank = priorityRank[fetchPriority];
		if ((warmedPosters.get(poster) ?? -1) >= rank) return;
		warmedPosters.set(poster, rank);
		const image = new Image();
		image.fetchPriority = fetchPriority;
		image.onerror = () => {
			if (warmedPosters.get(poster) === rank) warmedPosters.delete(poster);
		};
		image.src = poster;
	} catch {
		/* Optional work cannot interrupt focus or navigation. */
	}
}

export type VideoPreconnect = {
	readonly active: boolean;
	prepare: () => void;
};

const key = Symbol('video-preconnect');

export function setVideoPreconnect(): VideoPreconnect {
	let active = $state(false);
	const value: VideoPreconnect = {
		get active() {
			return active;
		},
		prepare() {
			active = true;
		}
	};
	return setContext(key, value);
}

export function useVideoPreconnect() {
	return getContext<VideoPreconnect | undefined>(key);
}
