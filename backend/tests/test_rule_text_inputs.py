from routers import comfyui as comfyui_router


def test_rule_text_params_cover_rule_declared_text_inputs_only():
    rules = {
        "nodes": {
            "30:19": {"present": {"input_type": "text", "param": "value"}},
            "30:6": {"present": {"enabled": False}},
            "30:28": {
                "present": {"enabled": False, "input_type": "text", "param": "text"}
            },
            "477": {"present": {"input_type": "image", "param": "images"}},
            "30:3": {"widgets": {"seed": {"label": "Seed"}}},
        }
    }

    assert comfyui_router._resolve_rule_text_params(rules) == {"30:19": "value"}


def test_rule_text_params_tolerate_missing_rules():
    assert comfyui_router._resolve_rule_text_params(None) == {}
    assert comfyui_router._resolve_rule_text_params({}) == {}


def test_shipped_krea_prompts_resolve_to_their_primitive_value_param():
    # Both prompts are PrimitiveStringMultiline nodes, which object_info does
    # not auto-detect as text inputs; the rule mapping is their only route.
    warnings: list[dict] = []
    rules = comfyui_router._resolve_submission_rules(
        workflow_rules=None,
        workflow_id="vlo_krea2_turbo.json",
        workflow_warnings=warnings,
    )

    assert warnings == []
    assert comfyui_router._resolve_rule_text_params(rules) == {
        "30:19": "value",
        "30:54": "value",
    }


def test_submission_rules_prefer_the_inline_override():
    rules = comfyui_router._resolve_submission_rules(
        workflow_rules={
            "nodes": {"7": {"present": {"input_type": "text", "param": "value"}}}
        },
        workflow_id="vlo_krea2_turbo.json",
        workflow_warnings=[],
    )

    assert comfyui_router._resolve_rule_text_params(rules) == {"7": "value"}


def test_submission_rules_reject_unsafe_workflow_ids():
    assert (
        comfyui_router._resolve_submission_rules(
            workflow_rules=None,
            workflow_id="../secrets.json",
            workflow_warnings=[],
        )
        is None
    )
