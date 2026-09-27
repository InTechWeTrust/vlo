### Prompting MiniMax H3 with references

References are numbered in the order they are attached. Refer to them in the
prompt by tag, for example `<Picture 1>` or `<Video 2>`. Tags are matched by
position, so reordering references changes which one each tag means.

For the best results, write prompts the way the model was trained to read
them. MiniMax's official guide covers every reference label (`<Subject N>`,
`<Picture N>`, `<Video N>`, `<Audio N>`), how to use them across shots,
dialogue and sound, with a complete worked example:

**[MiniMax H3 video prompt writing guide (Reference)](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md)**
