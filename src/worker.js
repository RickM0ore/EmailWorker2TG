import PostalMime from 'postal-mime';
import { decode } from 'html-entities';

const MAX_TELEGRAM_MESSAGE_LENGTH = 3500;
const TELEGRAM_API_BASE = 'https://api.telegram.org/bot';

// --- 工具函数（与上一版本相同） ---

function escapeMarkdownV2(text) {
	const charsToEscape = /[_*\[\]()~`>#+\-=|{}.!]/g;
	return text.replace(charsToEscape, '\\$&');
}

/**
 * 发送消息到 Telegram, 如果消息太长则自动分割并以回复形式发送
 * @param {string} text - 要发送的完整文本
 * @param {{BOT_TOKEN: string, CHAT_ID: string}} env - 环境配置
 * @returns {Promise<number|null>} - 第一条消息的 message_id，用于附件回复
 */
async function sendSplitMessage(text, env) {
	const telegramApiUrl = `${TELEGRAM_API_BASE}${env.BOT_TOKEN}/sendMessage`;
	let lastMessageId = null;

	// 1. 分割逻辑（略，与上一版本相同）
	const chunks = [];
	if (text.length <= MAX_TELEGRAM_MESSAGE_LENGTH) {
		chunks.push(text);
	} else {
		for (let i = 0; i < text.length; i += MAX_TELEGRAM_MESSAGE_LENGTH) {
			chunks.push(text.substring(i, i + MAX_TELEGRAM_MESSAGE_LENGTH));
		}
	}

	// 2. 发送分片消息并建立回复链
	for (const chunk of chunks) {
		const payload = {
			chat_id: env.CHAT_ID,
			text: chunk,
			parse_mode: 'MarkdownV2'
		};
		if (lastMessageId) {
			payload.reply_to_message_id = lastMessageId;
		}

		const response = await fetch(telegramApiUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(payload)
		});

		const responseData = await response.json();
		if (!responseData.ok) {
			console.error(`发送分割消息失败: ${responseData.description}`);
			return lastMessageId; // 返回已发送消息的ID，继续附件流程
		}
		lastMessageId = responseData.result.message_id;
	}
	return lastMessageId;
}

// --- 核心函数：上传附件 ---

/**
 * 将单个附件上传到 Telegram
 * @param {object} attachment - postal-mime解析的附件对象
 * @param {number} replyToMessageId - 要回复的消息ID
 * @param {{BOT_TOKEN: string, CHAT_ID: string}} env - 环境配置
 */
async function sendAttachment(attachment, replyToMessageId, env) {
	const sendDocumentUrl = `${TELEGRAM_API_BASE}${env.BOT_TOKEN}/sendDocument`;
	const boundary = `----WorkerBoundary${Math.random().toString(16)}`;

	// 附件内容是 Base64 字符串，需要解码为 Uint8Array
	const attachmentData = new Uint8Array(attachment.content);

	// 构建 multipart/form-data 头部
	const parts = [];

	// 1. chat_id 字段 (JSON/文本部分)
	parts.push(
		`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${env.CHAT_ID}\r\n`
	);

	// 2. reply_to_message_id 字段 (JSON/文本部分)
	parts.push(
		`--${boundary}\r\nContent-Disposition: form-data; name="reply_to_message_id"\r\n\r\n${replyToMessageId}\r\n`
	);

	// 3. 附件文件部分 (二进制部分)
	// 文件名和 MIME 类型
	const filePartHeader = `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${attachment.filename}"\r\nContent-Type: ${attachment.mimeType}\r\n\r\n`;
	const filePartFooter = `\r\n--${boundary}--\r\n`;

	// 将所有部分转换为 Uint8Array 以便连接
	const encoder = new TextEncoder();

	const headerBytes = encoder.encode(parts.join(''));
	const fileHeaderBytes = encoder.encode(filePartHeader);
	const fileFooterBytes = encoder.encode(filePartFooter);

	// 构造最终的请求体
	const bodyLength = headerBytes.length + fileHeaderBytes.length + attachmentData.length + fileFooterBytes.length;
	const requestBody = new Uint8Array(bodyLength);

	let offset = 0;
	requestBody.set(headerBytes, offset);
	offset += headerBytes.length;
	requestBody.set(fileHeaderBytes, offset);
	offset += fileHeaderBytes.length;
	requestBody.set(attachmentData, offset);
	offset += attachmentData.length;
	requestBody.set(fileFooterBytes, offset);

	// 发送请求
	const response = await fetch(sendDocumentUrl, {
		method: 'POST',
		headers: {
			'Content-Type': `multipart/form-data; boundary=${boundary}`
		},
		body: requestBody // 直接发送 Uint8Array
	});

	if (!response.ok) {
		const errorData = await response.json();
		console.error(`上传附件失败 (${attachment.filename}): ${errorData.description}`);
	}
}

class ElementHandler {
	constructor() {
		this.markdownOutput = '';
		this.tag = '';
		this.herf = '';
		this.src = '';
		this.textAppender = '';
		this.nestedInA = false;
	}

	// 处理所有元素（除了 <a> 标签，我们在单独的处理器中处理）
	// 目标：移除所有标签，只保留文本
	element(element) {
		if (['style', 'script'].includes(element.tagName.toLowerCase())) {
			element.remove();
			return;
		}
		if (['br'].includes(element.tagName.toLowerCase()))
			return;
		this.tag = element.tagName.toLowerCase();
		if (element.tagName === 'a') {
			this.herf = element.getAttribute('href') || '';
			this.nestedInA = true;
			element.onEndTag(() => {
				this.nestedInA = false;
			});
		}
		if (['img', 'video', 'iframe', 'audio'].includes(element.tagName.toLowerCase())) {
			this.src = element.getAttribute('src');
		}
		element.removeAndKeepContent();
		console.log('ElementHandler element', element);
		// 对于链接 (a) 标签，我们什么都不做，让 a 标签处理器来处理
	}

	// 处理文本内容
	text(text) {
		console.log('ElementHandler text', text);
		if (this.tag === 'td')
			text.after(' ');
		if (this.tag === 'a') {
			text.replace(`[ ${escapeMarkdownV2(text.text).trim()} ](${this.herf})`);
			this.tag = '';
			return;
		} else if (['img', 'video', 'iframe', 'audio'].includes(this.tag) && !this.nestedInA) {
			if (text.lastInTextNode) {
				text.replace(`[ ${this.tag} ](${this.src})`);
				this.tag = '';
			}
			return;
		}
		text.replace(escapeMarkdownV2(text.text) + '\n');
	}

}


class DocumentHandler {
	comments(comment) {
		comment.remove();
	}
}


async function processHtml(html) {

	const rewriterInstance = new HTMLRewriter();
	rewriterInstance.on('*', new ElementHandler()); // 捕获所有元素的开始和文本
	rewriterInstance.onDocument(new DocumentHandler());
	let text = await rewriterInstance.transform(new Response(html)).text();
	text =
		text.split('\n').map(row => {
			return decode(row.trim());
		}).filter(row => {
			return !!row.trim();
		});
	return text.join('\n').replaceAll(/<br\/?>/g, '\n');
}

// --- Email Worker 入口 ---

export default {
	/**
	 * @param {ForwardableEmailMessage} message
	 * @param {{BOT_TOKEN: string, CHAT_ID: string}} env
	 * @param {any} ctx
	 */
	async email(message, env, ctx) {
		try {
			const parser = new PostalMime();
			const parsedEmail = await parser.parse(message.raw);

			// 1. 构建并发送主邮件内容
			const from = parsedEmail.from ? `${escapeMarkdownV2(parsedEmail.from.name ?? '')} <\`${parsedEmail.from.address}\`\\>` : '未知发件人';
			const to = parsedEmail.to ? parsedEmail.to.map(rcpt => `${escapeMarkdownV2(rcpt.name ?? '')} <\`${rcpt.address}\`\\>`).join(', ') : '未知收件人';
			const subject = parsedEmail.subject || '\\(无主题\\)';
			let body = parsedEmail.text || parsedEmail.html || '\\(无内容\\)';
			let escaped;
			if (parsedEmail.text)
				escaped = escapeMarkdownV2(decode(parsedEmail.text));
			else
				escaped = await processHtml(body);
// 3. 构建消息，并对不可控的部分进行转义
// 头部是我们自己控制的，所以不需要转义
			const fullMessageText = `
📬 **新邮件**
**${subject}**
**From:** ${from}
**To:** ${to}
\\=\\=\\=\\=\\=\\=
${escaped}
      `;

			// 发送主消息，并获取它的 ID
			const firstMessageId = await sendSplitMessage(fullMessageText, env);

			// 2. 循环发送附件
			if (parsedEmail.attachments.length > 0 && firstMessageId) {
				for (const attachment of parsedEmail.attachments) {
					// 在发送附件时，回复到主消息 (firstMessageId)
					await sendAttachment(attachment, firstMessageId, env);
				}
			}

		} catch (error) {
			console.error(`邮件处理失败: ${error.message}`);
			await sendSplitMessage(`
📬 **新邮件**
**${message?.headers?.get('Subject') || '未获取到标题'}**
**From:** ${message.from}
**To:** ${message.to}
\\-\\-\\-\\-\\-\\-
(解析正文错误): ${error.message}
`, env);
		}
	}
};


