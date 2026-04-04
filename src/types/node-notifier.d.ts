declare module 'node-notifier' {
  export interface NotificationOptions {
    title: string;
    message: string;
    subtitle?: string;
    sound?: boolean;
    wait?: boolean;
  }

  export interface NodeNotifier {
    notify(options: NotificationOptions): void;
  }

  const notifier: NodeNotifier;
  export default notifier;
}
