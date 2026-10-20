<div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
	<svg class="block size-full" width="100%" height="100%" preserveAspectRatio="none">
		<defs>
			<pattern id="auth-light-grid" width="8" height="8" patternUnits="userSpaceOnUse">
				<rect width="2" height="2" rx="0.32" fill="#bfbfbf" opacity="0.14" />
			</pattern>
			<pattern id="auth-mid-grid" width="8" height="8" patternUnits="userSpaceOnUse">
				<rect width="2" height="2" rx="0.32" fill="#b2b2b2" opacity="0.48" />
			</pattern>
			<pattern id="auth-dark-grid" width="8" height="8" patternUnits="userSpaceOnUse">
				<rect width="2" height="2" rx="0.32" fill="#a5a5a5" opacity="0.68" />
			</pattern>
			<radialGradient id="auth-patch-a" cx="0.18" cy="0.12" r="0.38">
				<stop offset="0" stop-color="white" stop-opacity="1" />
				<stop offset="0.52" stop-color="white" stop-opacity="0.48" />
				<stop offset="1" stop-color="white" stop-opacity="0" />
			</radialGradient>
			<radialGradient id="auth-patch-b" cx="0.66" cy="0.23" r="0.34">
				<stop offset="0" stop-color="white" stop-opacity="0.92" />
				<stop offset="0.54" stop-color="white" stop-opacity="0.42" />
				<stop offset="1" stop-color="white" stop-opacity="0" />
			</radialGradient>
			<radialGradient id="auth-patch-c" cx="0.28" cy="0.78" r="0.38">
				<stop offset="0" stop-color="white" stop-opacity="0.9" />
				<stop offset="0.54" stop-color="white" stop-opacity="0.4" />
				<stop offset="1" stop-color="white" stop-opacity="0" />
			</radialGradient>
			<radialGradient id="auth-patch-d" cx="0.9" cy="0.82" r="0.4">
				<stop offset="0" stop-color="white" stop-opacity="0.96" />
				<stop offset="0.52" stop-color="white" stop-opacity="0.44" />
				<stop offset="1" stop-color="white" stop-opacity="0" />
			</radialGradient>
			<mask id="auth-mask-a" maskContentUnits="objectBoundingBox">
				<rect width="1" height="1" fill="url(#auth-patch-a)" />
			</mask>
			<mask id="auth-mask-b" maskContentUnits="objectBoundingBox">
				<rect width="1" height="1" fill="url(#auth-patch-b)" />
			</mask>
			<mask id="auth-mask-c" maskContentUnits="objectBoundingBox">
				<rect width="1" height="1" fill="url(#auth-patch-c)" />
			</mask>
			<mask id="auth-mask-d" maskContentUnits="objectBoundingBox">
				<rect width="1" height="1" fill="url(#auth-patch-d)" />
			</mask>
		</defs>
		<rect width="100%" height="100%" fill="url(#auth-light-grid)" />
		<rect width="100%" height="100%" fill="url(#auth-mid-grid)" mask="url(#auth-mask-a)" />
		<rect width="100%" height="100%" fill="url(#auth-dark-grid)" mask="url(#auth-mask-b)" />
		<rect width="100%" height="100%" fill="url(#auth-mid-grid)" mask="url(#auth-mask-c)" />
		<rect width="100%" height="100%" fill="url(#auth-dark-grid)" mask="url(#auth-mask-d)" />
	</svg>
</div>
