import { pino } from 'pino';
import { config } from '../config/index.js';
import type { Task, DailyDigest, NotificationChannel } from '../types/index.js';

const logger = pino({ name: 'notification' });

// ── Formatters ──

export function formatTaskForSlack(task: Task): Record<string, unknown> {
  const riskEmoji = { low: ':white_check_mark:', medium: ':warning:', high: ':red_circle:' };
  const evidence = typeof task.evidence === 'string' ? JSON.parse(task.evidence as string) : task.evidence;

  return {
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${task.title}*\n${task.description}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Type:* ${task.type}` },
          { type: 'mrkdwn', text: `*Risk:* ${riskEmoji[task.riskLevel]} ${task.riskLevel}` },
          { type: 'mrkdwn', text: `*Confidence:* ${Math.round(task.confidence * 100)}%` },
          { type: 'mrkdwn', text: `*Files:* ${task.impact.estimatedFiles.length}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Evidence: ${evidence.signals?.slice(0, 2).join(' | ') ?? 'N/A'}`,
          },
        ],
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Approve' },
            style: 'primary',
            action_id: `approve_${task.id}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Dismiss' },
            style: 'danger',
            action_id: `dismiss_${task.id}`,
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Snooze 24h' },
            action_id: `snooze_${task.id}`,
          },
        ],
      },
    ],
  };
}

export function formatTaskForEmail(task: Task): { subject: string; html: string } {
  const evidence = typeof task.evidence === 'string' ? JSON.parse(task.evidence as string) : task.evidence;
  const verification = typeof task.verification === 'string' ? JSON.parse(task.verification as string) : task.verification;

  return {
    subject: `[Repo Steward] ${task.title}`,
    html: `
      <div style="font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #1a1a1a;">${task.title}</h2>
        <p style="color: #4a4a4a;">${task.description}</p>
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="padding: 8px; border: 1px solid #e0e0e0;"><strong>Type</strong></td>
            <td style="padding: 8px; border: 1px solid #e0e0e0;">${task.type}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #e0e0e0;"><strong>Risk</strong></td>
            <td style="padding: 8px; border: 1px solid #e0e0e0;">${task.riskLevel}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #e0e0e0;"><strong>Confidence</strong></td>
            <td style="padding: 8px; border: 1px solid #e0e0e0;">${Math.round(task.confidence * 100)}%</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #e0e0e0;"><strong>Est. Files</strong></td>
            <td style="padding: 8px; border: 1px solid #e0e0e0;">${task.impact.estimatedFiles.join(', ') || 'TBD'}</td>
          </tr>
        </table>
        <h3>Evidence</h3>
        <ul>
          ${(evidence.signals ?? []).map((s: string) => `<li>${s}</li>`).join('')}
        </ul>
        <h3>Verification</h3>
        <ul>
          ${(verification.steps ?? []).map((s: string) => `<li>${s}</li>`).join('')}
        </ul>
        <div style="margin-top: 24px;">
          <a href="#approve" style="background: #22c55e; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin-right: 8px;">Approve</a>
          <a href="#dismiss" style="background: #ef4444; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none; margin-right: 8px;">Dismiss</a>
          <a href="#snooze" style="background: #6b7280; color: white; padding: 10px 20px; border-radius: 6px; text-decoration: none;">Snooze 24h</a>
        </div>
      </div>
    `,
  };
}

export function formatTaskForGitHub(task: Task): { title: string; body: string } {
  const evidence = typeof task.evidence === 'string' ? JSON.parse(task.evidence as string) : task.evidence;
  const verification = typeof task.verification === 'string' ? JSON.parse(task.verification as string) : task.verification;

  return {
    title: `[Steward] ${task.title}`,
    body: `## Repo Steward Suggestion

**Type:** ${task.type}
**Risk:** ${task.riskLevel}
**Confidence:** ${Math.round(task.confidence * 100)}%

### Description
${task.description}

### Evidence
${(evidence.signals ?? []).map((s: string) => `- ${s}`).join('\n')}

### Verification Plan
${(verification.steps ?? []).map((s: string) => `- [ ] ${s}`).join('\n')}

### Success Criteria
${(verification.successCriteria ?? []).map((s: string) => `- ${s}`).join('\n')}

---
_Suggested by [Repo Steward](https://github.com/apps/repo-steward) • Confidence: ${Math.round(task.confidence * 100)}%_`,
  };
}

// ── Delivery ──

export async function sendSlackNotification(webhookUrl: string, payload: Record<string, unknown>): Promise<void> {
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Slack webhook returned ${response.status}`);
    }
    logger.info('Slack notification sent');
  } catch (err) {
    logger.error({ err }, 'Failed to send Slack notification');
  }
}

export async function notifyTask(
  task: Task,
  channels: NotificationChannel[],
  options?: { slackWebhookUrl?: string },
): Promise<void> {
  for (const channel of channels) {
    switch (channel) {
      case 'slack':
        if (options?.slackWebhookUrl) {
          const slackPayload = formatTaskForSlack(task);
          await sendSlackNotification(options.slackWebhookUrl, slackPayload);
        }
        break;

      case 'email':
        // Email sending would be implemented with nodemailer or similar
        logger.info({ taskId: task.id }, 'Email notification: not yet implemented');
        break;

      case 'github':
        // GitHub notification would create an issue or comment
        logger.info({ taskId: task.id }, 'GitHub notification: handled via webhook response');
        break;
    }
  }
}

export async function sendDailyDigest(digest: DailyDigest): Promise<void> {
  logger.info(
    {
      repoId: digest.repoId,
      date: digest.date,
      suggestions: digest.suggestions.length,
    },
    'Sending daily digest',
  );

  // In production, this sends a consolidated notification
  // For now, notify each task individually
  for (const suggestion of digest.suggestions) {
    await notifyTask(suggestion.task, ['slack', 'github']);
  }
}
