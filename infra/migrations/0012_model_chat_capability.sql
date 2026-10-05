-- 0012_model_chat_capability — give every model a modality and a `chat`
-- capability claim.
--
-- Why: the router's global virtual models (`fudrouter/auto`, `fudrouter/fast`,
-- …) are chat-completions names, but their target set is "every active model"
-- (store.ResolveModel, spec §5). `model.modality` and `model.capabilities` were
-- `{}` on all 284 rows, and CapabilitySatisfied only eliminates a candidate on
-- an explicit `false` — so a chat request could resolve to an embedding model
-- (`BAAI/bge-m3`) or an image/video model. The provider then answered 400
-- INVALID_REQUEST, which is classified request-shaped, so the fallback walk
-- stopped instead of trying a chat-capable target.
--
-- After this migration the virtuals declare `chat: true` (store/virtualModels)
-- and every non-chat model carries an explicit `chat: false`, so
-- CapabilitySatisfied drops it. `modality` is recorded so the catalogue and the
-- UI can show the model's kind.
--
-- Classification is name-based and deliberately conservative: only slugs that
-- name an image/video/audio/embedding/rerank/moderation family are marked
-- non-chat. A false positive (a chat model hidden from the virtuals) is worse
-- than a false negative (a stray non-chat candidate the fallback walk steps
-- over), so ambiguous names stay chat.

UPDATE model
SET modality = CASE
      WHEN slug ~* 'embed|rerank|(^|[/_-])bge(-|/|$)' THEN '{"type":"embedding"}'::jsonb
      WHEN slug ~* 'image|flux|dall-e|ideogram|imagen|nano-banana|seedream|recraft|(^|[/_-])krea(-|/|$)|phoenix-|kino-|anime-xl|concept-art|graphic-design|illustrative-|lifelike-|lightning-xl|lucid-|motion_|portrait-|stock-photography|stable-diffusion' THEN '{"type":"image"}'::jsonb
      WHEN slug ~* 'video|veo-|sora|kling|runway|seedance|wan-|hailuo|ltxv|happy-horse|grok-imagine' THEN '{"type":"video"}'::jsonb
      WHEN slug ~* 'whisper|tts|audio|speech|voice|music' THEN '{"type":"audio"}'::jsonb
      WHEN slug ~* 'moderation|content-safety' THEN '{"type":"moderation"}'::jsonb
      ELSE '{"type":"text"}'::jsonb
    END,
    capabilities = capabilities || CASE
      WHEN slug ~* 'embed|rerank|(^|[/_-])bge(-|/|$)' THEN '{"chat":false}'::jsonb
      WHEN slug ~* 'image|flux|dall-e|ideogram|imagen|nano-banana|seedream|recraft|(^|[/_-])krea(-|/|$)|phoenix-|kino-|anime-xl|concept-art|graphic-design|illustrative-|lifelike-|lightning-xl|lucid-|motion_|portrait-|stock-photography|stable-diffusion' THEN '{"chat":false}'::jsonb
      WHEN slug ~* 'video|veo-|sora|kling|runway|seedance|wan-|hailuo|ltxv|happy-horse|grok-imagine' THEN '{"chat":false}'::jsonb
      WHEN slug ~* 'whisper|tts|audio|speech|voice|music' THEN '{"chat":false}'::jsonb
      WHEN slug ~* 'moderation|content-safety' THEN '{"chat":false}'::jsonb
      ELSE '{"chat":true}'::jsonb
    END
WHERE capabilities->>'chat' IS NULL;
