import placeholderPoster from '$lib/assets/support-video-placeholder.svg?no-inline';
import type { EmbeddedVideo } from '$lib/ui/video.svelte';

// Temporary Blender open movies. Replace these IDs and posters with the walkthroughs when ready.
export const walkthroughVideos = {
	contracts: { id: 'YE7VzlLtp-4', title: 'Big Buck Bunny', poster: placeholderPoster },
	integrations: { id: 'SkVqJ1SGeL0', title: 'Caminandes 3: Llamigos', poster: placeholderPoster },
	templateSetup: { id: 'WhWc3b3KhnY', title: 'Spring', poster: placeholderPoster }
} satisfies Record<string, EmbeddedVideo>;
