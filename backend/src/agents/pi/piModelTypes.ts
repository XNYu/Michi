import type { ModelReasoningCapabilities } from "michi-shared";

export interface PiModelInfo extends ModelReasoningCapabilities {
    model_id: string;
    model_name: string;
    description?: string;
    context_window_tokens?: number;
}
