import EventKit
import Foundation

enum CalendarServiceError: LocalizedError {
    case accessDenied
    case noCalendar

    var errorDescription: String? {
        switch self {
        case .accessDenied:
            return "没有日历权限，请在系统设置中允许财富流通中心访问日历。"
        case .noCalendar:
            return "没有找到可写入的日历。"
        }
    }
}

final class CalendarService {
    private let eventStore = EKEventStore()

    func addQuest(_ quest: StudyQuest) async throws -> String {
        let granted = try await requestAccessIfNeeded()
        guard granted else { throw CalendarServiceError.accessDenied }

        guard let calendar = eventStore.defaultCalendarForNewEvents else {
            throw CalendarServiceError.noCalendar
        }

        let event = EKEvent(eventStore: eventStore)
        event.calendar = calendar
        event.title = quest.calendarTitle
        event.startDate = quest.start
        event.endDate = quest.end
        event.notes = "来自财富流通中心：\(quest.taskType.label)"

        try eventStore.save(event, span: .thisEvent, commit: true)
        return "已写入苹果日历"
    }

    private func requestAccessIfNeeded() async throws -> Bool {
        let status = EKEventStore.authorizationStatus(for: .event)
        #if os(macOS)
        if #available(macOS 14.0, *) {
            if status == .fullAccess || status == .writeOnly {
                return true
            }
            guard status == .notDetermined else {
                return false
            }
            return try await eventStore.requestFullAccessToEvents()
        }
        return false
        #else
        if #available(iOS 17.0, *) {
            if status == .fullAccess || status == .writeOnly {
                return true
            }
        } else {
            if status == .authorized {
                return true
            }
        }

        guard status == .notDetermined else {
            return false
        }

        if #available(iOS 17.0, *) {
            return try await eventStore.requestFullAccessToEvents()
        }

        return try await withCheckedThrowingContinuation { continuation in
            eventStore.requestAccess(to: .event) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
        #endif
    }
}
