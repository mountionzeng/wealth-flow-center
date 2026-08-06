import Foundation
import UserNotifications

final class NotificationService {
    func scheduleStudyReminder(for quest: StudyQuest) async throws {
        let center = UNUserNotificationCenter.current()
        let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
        guard granted else { return }

        let content = UNMutableNotificationContent()
        content.title = "学习时间到了"
        content.body = quest.displayTitle
        content.sound = .default

        let triggerDate = Calendar.current.dateComponents(
            [.year, .month, .day, .hour, .minute],
            from: quest.start
        )
        let trigger = UNCalendarNotificationTrigger(dateMatching: triggerDate, repeats: false)
        let request = UNNotificationRequest(
            identifier: "study-quest-\(quest.id)",
            content: content,
            trigger: trigger
        )
        try await center.add(request)
    }

    func removeReminder(for quest: StudyQuest) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(
            withIdentifiers: ["study-quest-\(quest.id)"]
        )
    }
}
