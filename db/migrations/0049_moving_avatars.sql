-- Animated avatars, bought like the other moving looks (design §8.16); "custom" is the only key.
ALTER TABLE user_looks DROP CONSTRAINT user_looks_kind_check;
ALTER TABLE user_looks ADD CHECK (kind IN ('background', 'frame', 'avatar'));
