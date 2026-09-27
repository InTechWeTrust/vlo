## Pose control

**This workflow copies a person's pose**, mapping their motion onto a new
person.

### Step by step

1. **Find the motion.** Pick a video of the person whose motion you want to
   copy. Aim for **15 seconds or less**.
2. **Load it.** Drop the video onto the main **load video** slot, or click the
   slot to select a stretch of the timeline.
3. **Describe the result.** Write a prompt for what you want to see.
   Optionally add reference assets in the **Image inputs**, **Video inputs**
   and **Audio inputs** slots — for example, an image of the new person to
   animate.

### ControlNet timing

**Advanced Settings → ControlNet Timing** has an **Active window** slider.
The pose guides the generation only between its **Start** and **End** points,
measured through the sampling schedule. The default, 0–100%, guides every
step.

| Change | Effect |
| --- | --- |
| Start later | The model lays out the scene freely before the pose takes hold |
| End earlier | The final detail steps run unguided, so the pose is followed more loosely |

If Start reaches End, the slider reads **off** and the pose is not applied.

::include{src="shared:minimax/prompting-reference.md"}
