import type { Infer } from 'convex/values';
import type { templateContent } from '../../convex/templateValidators';

export type TemplateContent = Infer<typeof templateContent>;
