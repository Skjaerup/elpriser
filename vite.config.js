import { defineConfig } from 'vite';

export default defineConfig({
	server: {
		proxy: {
			'/api/prices': {
				target: 'https://api.energidataservice.dk',
				changeOrigin: true,
				secure: true,
				rewrite: (path) => path.replace(/^\/api\/prices/, '/dataset/DayAheadPrices'),
			},
		},
	},
});
