"""Quantized reasoning-depth inference on the process MLX scheduler."""
from __future__ import annotations

import copy

from .component import QwenThinkingRouter


class MLXThinkingRouter(QwenThinkingRouter):
    """Reuse the depth policy with local int8 weights and a static prompt cache.

    Model and KV state belong to the shared GPU thread. Only the system prompt
    and examples enter the prefix cache; each request gets its own mutable copy.
    """

    def __init__(self, model: str | None = None) -> None:
        super().__init__(model=model)
        self._prefix_key = None
        self._prefix_tokens = []
        self._prefix_cache = None

    def _load_mlx(self):
        if self._model is None:
            import mlx.core as mx
            from mlx_lm import load
            from mlx_lm.utils import quantize_model

            model, tokenizer, config = load(
                self.model_name, lazy=True, return_config=True)
            if not config.get('quantization'):
                model, _ = quantize_model(model, config, group_size=64, bits=8)
            mx.eval(model.parameters())
            model.eval()
            self._model, self._tokenizer = model, tokenizer
            print('[thinking] router ready: MLX with static prefix cache', flush=True)
        return self._tokenizer, self._model

    def _predict(self, system: str, examples, prompt: str) -> str:
        from voicemem.utils.gpu_loop import gpu_loop

        self._ensure_model_source()
        return gpu_loop().call(lambda: self._predict_on_gpu(system, examples, prompt))

    def _predict_on_gpu(self, system: str, examples, prompt: str) -> str:
        import mlx.core as mx
        from mlx_lm.models.cache import make_prompt_cache

        tokenizer, model = self._load_mlx()
        examples = tuple(examples)
        messages = [{'role': 'system', 'content': system}]
        for text, label in examples:
            messages.extend(({'role': 'user', 'content': text},
                             {'role': 'assistant', 'content': label}))

        def tokenize(text, generation):
            return tokenizer.apply_chat_template(
                messages + [{'role': 'user', 'content': text}],
                tokenize=True, add_generation_prompt=generation, enable_thinking=False)

        key = (system, examples)
        if key != self._prefix_key:
            # Include a final user message when rendering: Qwen templates can
            # otherwise format earlier assistant turns differently. The common
            # prefix of two distinct stubs stops before request-specific text.
            left, right = tokenize('', False), tokenize('x', False)
            count = next((i for i, (a, b) in enumerate(zip(left, right)) if a != b),
                         min(len(left), len(right)))
            prefix = left[:count]
            cache = make_prompt_cache(model)
            if prefix:
                model(mx.array(prefix)[None], cache=cache)
                mx.eval([layer.state for layer in cache])
            self._prefix_tokens, self._prefix_cache = prefix, cache
            self._prefix_key = key

        tokens = tokenize(prompt, True)
        count = len(self._prefix_tokens)
        if count < len(tokens) and tokens[:count] == self._prefix_tokens:
            tokens = tokens[count:]
            cache = copy.deepcopy(self._prefix_cache)
        else:
            cache = make_prompt_cache(model)
        # A four-token greedy classifier does not need the text-generation
        # wrapper, which changes the process-wide wired-memory limit and clears
        # allocator caches also used by TTS. Keep inference on the owned stream.
        pending = mx.array(tokens)
        while len(pending) > 512:
            model(pending[:512][None], cache=cache)
            mx.eval([layer.state for layer in cache])
            pending = pending[512:]
        generated = []
        for _ in range(4):
            logits = model(pending[None], cache=cache)
            token = mx.argmax(logits[:, -1, :], axis=-1).item()
            if token in tokenizer.eos_token_ids:
                break
            generated.append(token)
            pending = mx.array([token])
        return tokenizer.decode(generated).strip()
