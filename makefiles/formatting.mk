check:
	bunx biome check ./;
.PHONY: check

format:
	bunx biome check ./ --write --unsafe;
.PHONY: format

fix:
	bunx biome check ./ --write --unsafe;
.PHONY: fix
